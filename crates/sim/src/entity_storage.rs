//! Entity records in the simulation's chunk save format.
use world::io::{DecodeError, Reader, Writer};
use world::{items, HEIGHT, MIN_Y};

use crate::{entity::Entity, entity::EntityKind, health::VOID_Y, mob::Mob, ChunkPos, Server};

const MAX_SAVED_Y: f64 = (MIN_Y + HEIGHT + 64) as f64;
const ANIMAL: u8 = 0;
const ITEM: u8 = 1;
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

pub(super) fn read_motion(
    chunk: ChunkPos,
    r: &mut Reader,
) -> Result<([f64; 3], [f64; 3]), DecodeError> {
    let pos = [r.f64()?, r.f64()?, r.f64()?];
    let velocity = [r.f64()?, r.f64()?, r.f64()?];
    if !valid_position(chunk, pos) || !velocity.iter().all(|v| v.is_finite()) {
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
            ITEM => {
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
        let animals = self
            .mobs
            .iter()
            .filter(|(_, mob)| mob.is_animal() && valid_position(chunk, mob.pos()))
            .map(|(&id, mob)| (id, SavedEntity::Animal(mob)));
        let items = self
            .entities
            .iter()
            .filter(|(_, item)| valid_position(chunk, item.pos))
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
                    w.u8(ITEM);
                    w.u16(item.item);
                    w.u8(item.count);
                    for value in item.pos.into_iter().chain(item.velocity) {
                        w.f64(value);
                    }
                    w.i32(item.age as i32);
                    w.i32(item.pickup_delay as i32);
                }
            }
        }
    }

    pub(super) fn mark_entity_chunk(&mut self, chunk: ChunkPos) {
        if self.world.chunks.contains_key(&chunk) {
            self.entity_changes.insert(chunk);
        }
    }

    pub(super) fn mark_entity_chunks(&mut self) {
        let chunks = self.entities.values().map(Entity::chunk).chain(
            self.mobs
                .values()
                .filter(|mob| mob.is_animal())
                .map(Mob::chunk),
        );
        self.entity_changes
            .extend(chunks.filter(|chunk| self.world.chunks.contains_key(chunk)));
    }

    /// Includes the latest entity state in the next explicit world save.
    pub fn flush_entity_changes(&mut self) {
        for chunk in &self.entity_changes {
            if let Some(chunk) = self.world.chunks.get_mut(chunk) {
                chunk.dirty = true;
            }
        }
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
    fn marks_are_batched_at_600_ticks_and_include_both_chunks_after_a_move() {
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
        assert_eq!(source.entities[&1].chunk(), (1, 0));
        assert_eq!(source.dirty_chunks(), 0);
        assert!(source.take_dirty().is_none());
        source.tick();
        assert_eq!(source.game_time, 600);
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
}
