//! Entity records in the simulation's chunk save format.
use world::io::{DecodeError, Reader, Writer};
use world::{items, HEIGHT, MIN_Y};

use crate::{entity::Entity, entity::EntityKind, health::VOID_Y, mob::Mob, ChunkPos, Server};

// The swept collision scan visits a box sized by the three velocity components.
// Airborne mobs approach 3.92 blocks/tick ((v - 0.08) * 0.98), drops approach
// 1.96 after drag, and even a fully drawn bow launches at 3.0. Eight per axis
// leaves room above those speeds while bounding the number of cells scanned.
const MAX_SAVED_SPEED: f64 = 8.0;
const MAX_SAVED_Y: f64 = (MIN_Y + HEIGHT + 64) as f64;
const ANIMAL: u8 = 0;
const ITEM: u8 = 1;
const DAMAGED_ITEM: u8 = 2;
const MIN_RECORD_BYTES: usize = 1 + 2 + 1 + 6 * 8 + 2 * 4;

pub(super) enum SavedEntity<M = Mob, I = Entity> {
    Animal(M),
    Item(I),
}

fn valid_position((cx, cz): ChunkPos, [x, y, z]: [f64; 3]) -> bool {
    let x0 = f64::from(cx) * 16.0;
    let z0 = f64::from(cz) * 16.0;
    (x0..x0 + 16.0).contains(&x)
        && (z0..z0 + 16.0).contains(&z)
        && (VOID_Y..=MAX_SAVED_Y).contains(&y)
}

fn valid_velocity(velocity: [f64; 3]) -> bool {
    velocity.iter().all(|v| v.abs() <= MAX_SAVED_SPEED)
}

pub(super) fn read_motion(
    chunk: ChunkPos,
    r: &mut Reader,
) -> Result<([f64; 3], [f64; 3]), DecodeError> {
    let pos = [r.f64()?, r.f64()?, r.f64()?];
    let velocity = [r.f64()?, r.f64()?, r.f64()?];
    if !valid_position(chunk, pos) || !valid_velocity(velocity) {
        return Err(DecodeError);
    }
    Ok((pos, velocity))
}

pub(super) fn read_saved_entities(
    chunk: ChunkPos,
    r: &mut Reader,
) -> Result<Vec<SavedEntity>, DecodeError> {
    let bytes = r.rest();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let mut r = Reader::new(bytes);
    let count = r.varint()? as usize;
    let oversized_count = bytes.len() - r.remaining() == 5 && bytes[4] > 0x0f;
    if oversized_count || count > r.remaining() / MIN_RECORD_BYTES {
        return Err(DecodeError);
    }
    let mut entities = Vec::new();
    for _ in 0..count {
        entities.push(match r.u8()? {
            ANIMAL => SavedEntity::Animal(Mob::read_saved(chunk, &mut r)?),
            tag @ (ITEM | DAMAGED_ITEM) => {
                let item = r.u16()?;
                let count = r.u8()?;
                if count == 0 || items::info(item).is_none_or(|info| count > info.max_stack) {
                    return Err(DecodeError);
                }
                let (pos, velocity) = read_motion(chunk, &mut r)?;
                SavedEntity::Item(Entity {
                    kind: EntityKind::Item,
                    item,
                    count,
                    pos,
                    velocity,
                    age: r.i32()? as u32,
                    pickup_delay: r.i32()? as u32,
                    damage: if tag == DAMAGED_ITEM {
                        crate::inventory::normalize_damage(item, r.u16()?)
                    } else {
                        0
                    },
                    on_ground: false,
                })
            }
            _ => return Err(DecodeError),
        });
    }
    if r.remaining() != 0 {
        return Err(DecodeError);
    }
    Ok(entities)
}

impl Server {
    pub(super) fn remaining_entity_ids(&self) -> u64 {
        if self.next_entity_id == 0 {
            0
        } else {
            u64::from(u32::MAX - self.next_entity_id) + 1
        }
    }

    pub(super) fn write_saved_entities(&self, chunk: ChunkPos, w: &mut Writer) {
        if !self.entity_persistence {
            w.varint(0);
            return;
        }
        let animals = self
            .mobs
            .iter()
            .filter(|(_, mob)| {
                mob.is_animal()
                    && valid_position(chunk, mob.pos())
                    && valid_velocity(mob.velocity())
            })
            .map(|(&id, mob)| (id, SavedEntity::Animal(mob)));
        let items = self
            .entities
            .iter()
            .filter(|(_, item)| valid_position(chunk, item.pos) && valid_velocity(item.velocity))
            .map(|(&id, item)| (id, SavedEntity::Item(item)));
        let mut entities: Vec<_> = animals.chain(items).collect();
        entities.sort_unstable_by_key(|(id, _)| *id);
        w.varint(entities.len() as u32);
        for (_, entity) in entities {
            match entity {
                SavedEntity::Animal(mob) => {
                    w.u8(ANIMAL);
                    mob.write_saved(w);
                }
                SavedEntity::Item(item) => {
                    w.u8(if item.damage == 0 { ITEM } else { DAMAGED_ITEM });
                    w.u16(item.item);
                    w.u8(item.count);
                    for value in item.pos.into_iter().chain(item.velocity) {
                        w.f64(value);
                    }
                    w.i32(item.age as i32);
                    w.i32(item.pickup_delay as i32);
                    if item.damage != 0 {
                        w.u16(item.damage);
                    }
                }
            }
        }
    }

    pub fn set_entity_persistence(&mut self, enabled: bool) {
        self.entity_persistence = enabled;
        if !enabled {
            self.entity_changes.clear();
            self.entity_dirty.clear();
            self.entity_unloads.clear();
        }
    }

    pub(super) fn dirty_entity_chunk(&mut self, chunk: ChunkPos) {
        if self.entity_persistence {
            self.entity_dirty.insert(chunk);
        }
    }

    pub(super) fn mark_entity_chunks(&mut self) {
        if !self.entity_persistence {
            return;
        }
        let chunks = self.entities.values().map(Entity::chunk).chain(
            self.mobs
                .values()
                .filter(|mob| mob.is_animal())
                .map(Mob::chunk),
        );
        let mut waiting_for_chunk = std::collections::BTreeSet::new();
        for chunk in chunks {
            if self.world.chunks.contains_key(&chunk) {
                self.entity_changes.insert(chunk);
            } else {
                waiting_for_chunk.insert(chunk);
            }
        }
        // A drop can precede streaming its chunk. Keep its immediate save
        // pending until the chunk arrives or the last such entity is removed.
        self.entity_dirty.retain(|chunk| {
            self.world.chunks.contains_key(chunk) || waiting_for_chunk.contains(chunk)
        });
    }

    /// Includes the latest entity state in the next explicit world save.
    pub fn flush_entity_changes(&mut self) {
        self.entity_dirty.extend(&self.entity_changes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::MobKind;
    use world::Chunk;
    use worldgen::Generator;

    fn server() -> Server {
        let mut server = Server::new(5, Generator::Flat);
        server.world.insert_chunk(Chunk::empty(0, 0));
        server
    }

    fn save(server: &mut Server) -> Vec<u8> {
        server.world.chunks.get_mut(&(0, 0)).unwrap().dirty = true;
        let (cx, cz, bytes) = server.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        bytes
    }

    #[test]
    fn saved_animals_and_items_round_trip_in_shared_id_order() {
        let mut source = server();
        let pos = [2.5, 4.0, 3.5];
        source.spawn_mob(MobKind::Cow, pos);
        source.spawn_item(1, 5, pos, [-0.0, 0.25, 0.0], 37);
        source.entities.get_mut(&2).unwrap().age = 5399;
        source.spawn_mob(MobKind::Pig, pos);
        source.spawn_mob(MobKind::Chicken, pos);
        source.spawn_mob(MobKind::Sheep, pos);
        for kind in [MobKind::Zombie, MobKind::Skeleton, MobKind::Creeper] {
            source.spawn_mob(kind, pos);
        }
        source
            .arrows
            .insert(9, crate::arrow::Arrow::aimed(pos, pos));
        let bytes = save(&mut source);

        let restore = || {
            let mut target = Server::new(5, Generator::Flat);
            target.next_entity_id = 20;
            assert!(target.load_chunk(0, 0, &bytes));
            target
        };
        let mut target = restore();
        assert_eq!(
            target
                .mobs
                .iter()
                .map(|(&id, mob)| (id, mob.kind))
                .collect::<Vec<_>>(),
            [
                (20, MobKind::Cow),
                (22, MobKind::Pig),
                (23, MobKind::Chicken),
                (24, MobKind::Sheep)
            ]
        );
        let item = &target.entities[&21];
        assert_eq!(target.entities.len(), 1);
        assert_eq!(
            (item.item, item.count, item.age, item.pickup_delay),
            (1, 5, 5399, 37)
        );
        assert_eq!(item.pos, pos);
        assert_eq!(
            item.velocity.map(f64::to_bits),
            [-0.0, 0.25, 0.0].map(f64::to_bits)
        );
        assert!(!item.on_ground);
        assert!(target.arrows.is_empty());
        assert_eq!(target.next_entity_id, 25);
        assert_eq!(target.state_hash(), restore().state_hash());
        assert_eq!(save(&mut target), bytes);
    }

    #[test]
    fn item_records_preserve_damage_and_read_legacy_and_invalid_values() {
        let mut source = server();
        let item = items::by_name("wooden_pickaxe").unwrap();
        let pos = [2.5, 4.0, 3.5];
        source.spawn_item_stack(
            crate::Stack {
                item,
                count: 1,
                damage: 28,
            },
            pos,
            [0.0; 3],
            37,
        );
        let hash = source.state_hash();
        source.entities.get_mut(&1).unwrap().damage = 0;
        assert_ne!(source.state_hash(), hash);
        let legacy = save(&mut source);
        source.entities.get_mut(&1).unwrap().damage = 28;
        let bytes = save(&mut source);
        let tag = source.world.chunks[&(0, 0)].to_bytes().len() + 3;
        assert_eq!(legacy[tag], ITEM);
        assert_eq!(bytes[tag], DAMAGED_ITEM);

        let restore = |bytes: &[u8]| {
            let mut target = Server::new(5, Generator::Flat);
            assert!(target.load_chunk(0, 0, bytes));
            let entity = &target.entities[&1];
            (entity.item, entity.damage)
        };
        assert_eq!(restore(&legacy), (item, 0));
        assert_eq!(restore(&bytes), (item, 28));

        let mut invalid = bytes;
        let damage = invalid.len() - 2;
        invalid[damage..].copy_from_slice(&u16::MAX.to_be_bytes());
        assert_eq!(restore(&invalid), (item, 47));
        let stone = items::by_name("stone").unwrap();
        invalid[tag + 1..tag + 3].copy_from_slice(&stone.to_be_bytes());
        assert_eq!(restore(&invalid), (stone, 0));
    }

    #[test]
    fn zero_records_and_legacy_scheduled_ticks_load() {
        let mut source = server();
        let prefix = source.world.chunks[&(0, 0)].to_bytes();
        source.schedule_tick([3, 80, 3], 7);
        let bytes = save(&mut source);
        assert_eq!(&bytes[prefix.len()..], &[0, 1, 3, 0, 0, 0, 80, 3, 0, 7, 0]);

        for end in [prefix.len(), prefix.len() + 1, bytes.len() - 1, bytes.len()] {
            let mut target = Server::new(5, Generator::Flat);
            assert!(target.load_chunk(0, 0, &bytes[..end]));
            assert!(target.mobs.is_empty());
            assert!(target.entities.is_empty());
            assert_eq!(
                target.scheduled_blocks.len(),
                usize::from(end > prefix.len() + 1)
            );
        }
    }

    #[test]
    fn malformed_entities_discard_the_entire_chunk_and_allow_regeneration() {
        let mut source = server();
        source.world.set_block(0, 80, 0, world::blocks::GLASS);
        let prefix_len = source.world.chunks[&(0, 0)].to_bytes().len();
        source.spawn_mob(MobKind::Chicken, [2.5, 4.0, 3.5]);
        source.spawn_item(1, 5, [2.5, 4.0, 3.5], [0.0; 3], 0);
        let bytes = save(&mut source);
        let animal = prefix_len + 3; // Two old counts and the entity count.
        let item = animal + 62;
        let reject = |bytes: &[u8]| {
            let mut target = Server::new(5, Generator::Flat);
            target.set_stored([(0, 0)]);
            assert!(!target.ensure_chunk((0, 0)));
            assert_eq!(target.take_requests(), [(0, 0)]);
            assert!(!target.load_chunk(0, 0, bytes));
            assert!(target.world.chunks.is_empty());
            assert!(target.mobs.is_empty());
            assert!(target.entities.is_empty());
            assert_eq!(target.next_entity_id, 1);
            assert!(target.ensure_chunk((0, 0)));
            assert_eq!(target.stats.chunks_generated, 1);
            assert_eq!(target.world.get_block(0, 80, 0), Some(world::blocks::AIR));
        };

        for (offset, value) in [
            (animal - 1, 1),
            (animal - 1, 3),
            (animal, 2),
            (animal + 1, 4),
            (animal + 54, 0),
            (animal + 54, 5),
            (animal + 59, 2),
            (animal + 60, 255),
            (item + 1, 255),
            (item + 3, 0),
            (item + 3, 65),
        ] {
            let mut bad = bytes.clone();
            bad[offset] = value;
            reject(&bad);
        }
        for (offset, value) in [
            (animal + 2, -0.125),
            (animal + 10, VOID_Y - 1.0),
            (item + 12, MAX_SAVED_Y + 1.0),
            (item + 20, f64::NAN),
            (animal + 26, f64::INFINITY),
            (item + 28, f64::NEG_INFINITY),
        ] {
            let mut bad = bytes.clone();
            bad[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
            reject(&bad);
        }
        for end in [animal, item, bytes.len() - 1] {
            reject(&bytes[..end]);
        }
        let mut oversized_count = bytes.clone();
        oversized_count.splice(animal - 1..animal, [0x82, 0x80, 0x80, 0x80, 0x10]);
        reject(&oversized_count);
        let mut excess = bytes;
        excess.push(0);
        reject(&excess);
    }

    #[test]
    fn saved_velocity_bound_is_inclusive_and_invalid_records_are_not_written() {
        let mut source = server();
        let pos = [2.5, 4.0, 3.5];
        let limit = [MAX_SAVED_SPEED, -MAX_SAVED_SPEED, MAX_SAVED_SPEED];
        source.spawn_item(1, 5, pos, limit, 40);
        source.spawn_item(1, 5, pos, [1e12, 0.0, 0.0], 40);
        let prefix = source.world.chunks[&(0, 0)].to_bytes().len();
        let bytes = save(&mut source);
        let mut target = Server::new(5, Generator::Flat);
        assert!(target.load_chunk(0, 0, &bytes));
        assert_eq!(target.entities.len(), 1);
        assert_eq!(target.entities[&1].velocity, limit);

        // Counts (furnace, scheduled ticks, entity), then tag, item ID, count, position.
        let velocity_x = prefix + 3 + 4 + 24;
        for invalid in [MAX_SAVED_SPEED.next_up(), -MAX_SAVED_SPEED.next_up(), 1e12] {
            let mut bad = bytes.clone();
            bad[velocity_x..velocity_x + 8].copy_from_slice(&invalid.to_be_bytes());
            let mut target = Server::new(5, Generator::Flat);
            target.set_stored([(0, 0)]);
            assert!(!target.load_chunk(0, 0, &bad));
            assert!(target.entities.is_empty());
            assert!(target.ensure_chunk((0, 0)));
            assert_eq!(target.stats.chunks_generated, 1);
        }
    }

    #[test]
    fn crossing_dirties_both_chunks_before_the_600_tick_save() {
        let mut source = server();
        source.world.insert_chunk(Chunk::empty(1, 0));
        source.connect(1);
        source.spawn_item(1, 5, [15.8, 80.0, 3.5], [0.5, 0.0, 0.0], 40);
        let old = save(&mut source);
        assert_eq!(
            Server::read_saved_chunk(0, 0, &old).unwrap().entities.len(),
            1
        );
        source.game_time = 598;

        source.tick();
        assert_eq!(source.game_time, 599);
        assert_eq!(source.entities[&1].chunk(), (1, 0));
        assert_eq!(source.dirty_chunks(), 2);
        let (cx, cz, bytes) = source.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        assert!(Server::read_saved_chunk(cx, cz, &bytes)
            .unwrap()
            .entities
            .is_empty());
        let (cx, cz, bytes) = source.take_dirty().unwrap();
        assert_eq!((cx, cz), (1, 0));
        assert_eq!(
            Server::read_saved_chunk(cx, cz, &bytes)
                .unwrap()
                .entities
                .len(),
            1
        );
        assert!(source.take_dirty().is_none());
    }

    #[test]
    fn movement_within_one_chunk_waits_for_tick_600() {
        let mut source = server();
        source.connect(1);
        source.clients.get_mut(&1).unwrap().joined = true;
        source.set_external_generation(1);
        source.spawn_item(1, 5, [3.5, 80.0, 3.5], [0.5, 0.0, 0.0], 40);
        let first = save(&mut source);
        source.game_time = 598;

        source.tick();
        assert!(source.entities[&1].pos[0] > 3.5);
        assert_eq!(source.dirty_chunks(), 0);
        assert!(source.take_dirty().is_none());
        source.tick();
        assert_eq!(source.game_time, 600);
        let (cx, cz, bytes) = source.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        assert_ne!(bytes, first);
        let saved = Server::read_saved_chunk(cx, cz, &bytes).unwrap();
        assert!(
            matches!(&saved.entities[..], [SavedEntity::Item(item)] if item.pos == source.entities[&1].pos)
        );
        assert!(source.take_dirty().is_none());
    }

    #[test]
    fn drop_pickup_and_expiry_are_written_on_the_tick_they_happen() {
        use protocol::C2S;

        let mut source = Server::new(5, Generator::Flat);
        source.connect(1);
        source.apply(
            1,
            C2S::Hello {
                protocol: protocol::PROTOCOL_VERSION,
                view_distance: 2,
            },
        );
        source.tick();
        let item = source.clients[&1].inventory.selected_stack().unwrap().item;
        source.handle_packet(1, &C2S::DropItem { dir: [0.0; 3] }.encode());
        source.tick();
        assert!(source.clients[&1].inventory.selected_stack().is_none());
        let (cx, cz, bytes) = source.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        let saved = Server::read_saved_chunk(cx, cz, &bytes).unwrap();
        assert!(
            matches!(&saved.entities[..], [SavedEntity::Item(drop)] if drop.item == item && drop.count == 1)
        );
        assert!(source.take_dirty().is_none());

        let drop = source.entities.get_mut(&1).unwrap();
        drop.pos = source.clients[&1].pos;
        drop.velocity = [0.0; 3];
        drop.pickup_delay = 1;
        source.tick();
        assert_eq!(
            source.clients[&1].inventory.selected_stack().unwrap().item,
            item
        );
        let (cx, cz, bytes) = source.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        assert!(Server::read_saved_chunk(cx, cz, &bytes)
            .unwrap()
            .entities
            .is_empty());
        assert!(source.take_dirty().is_none());

        source.spawn_item(item, 1, [3.5, 80.0, 3.5], [0.0; 3], 40);
        source.entities.get_mut(&2).unwrap().age = 5999;
        let (cx, cz, bytes) = source.take_dirty().unwrap();
        assert_eq!(
            Server::read_saved_chunk(cx, cz, &bytes)
                .unwrap()
                .entities
                .len(),
            1
        );
        source.tick();
        assert!(source.entities.is_empty());
        let (cx, cz, bytes) = source.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        assert!(Server::read_saved_chunk(cx, cz, &bytes)
            .unwrap()
            .entities
            .is_empty());
        assert!(source.take_dirty().is_none());
    }

    #[test]
    fn persistence_off_releases_entity_chunks_and_preserves_block_dirty_chunks() {
        let mut source = server();
        source.set_entity_persistence(false);
        source.connect(1);
        source.clients.get_mut(&1).unwrap().joined = true;
        source.set_external_generation(1);
        for cx in [0, 30, 60] {
            source.world.insert_chunk(Chunk::empty(cx, 0));
            let pos = [f64::from(cx * 16) + 2.5, 80.0, 3.5];
            source.clients.get_mut(&1).unwrap().pos = pos;
            source.spawn_mob(MobKind::Cow, pos);
            source.spawn_item(1, 5, pos, [0.0; 3], 40);
            source.game_time = 599;
            source.tick();
            source.flush_entity_changes();
            assert_eq!(source.loaded_chunks(), 1);
            assert_eq!(source.dirty_chunks(), 0);
            assert_eq!(source.mobs.len(), 1);
            assert_eq!(source.entities.len(), 1);
            source.clients.get_mut(&1).unwrap().pos[0] += 16.0 * 25.0;
            source.unload_far_chunks();
            assert_eq!(source.loaded_chunks(), 0);
            assert!(source.mobs.is_empty());
            assert!(source.entities.is_empty());
            assert!(source.take_dirty().is_none());
        }
        source.world.insert_chunk(Chunk::empty(0, 0));
        assert_eq!(
            source.world.set_block(0, 80, 0, world::blocks::GLASS),
            Some(world::blocks::AIR)
        );
        source.unload_far_chunks();
        assert_eq!(source.loaded_chunks(), 1);
        assert_eq!(source.dirty_chunks(), 1);
    }

    #[test]
    fn restoring_two_chunks_evicts_the_oldest_drops_and_rewrites_their_chunk() {
        let snapshot = |cx, item| {
            let mut source = Server::new(5, Generator::Flat);
            source.world.insert_chunk(Chunk::empty(cx, 0));
            for _ in 0..600 {
                source.spawn_item(item, 1, [f64::from(cx * 16) + 2.5, 80.0, 3.5], [0.0; 3], 40);
            }
            source.take_dirty().unwrap().2
        };
        let mut target = Server::new(5, Generator::Flat);
        assert!(target.load_chunk(0, 0, &snapshot(0, 1)));
        assert_eq!(target.entities.len(), 600);
        assert_eq!(target.dirty_chunks(), 0);
        assert!(target.load_chunk(1, 0, &snapshot(1, 2)));
        assert_eq!(target.entities.len(), 1024);
        assert_eq!(
            target.entities.keys().copied().collect::<Vec<_>>(),
            (177..=1200).collect::<Vec<_>>()
        );
        assert_eq!(target.dirty_chunks(), 1);
        let (cx, cz, bytes) = target.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        assert_eq!(
            Server::read_saved_chunk(cx, cz, &bytes)
                .unwrap()
                .entities
                .len(),
            424
        );
        assert!(target.take_dirty().is_none());
    }
}
