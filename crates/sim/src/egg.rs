//! Thrown eggs are transient. Only chickens hatched from impacts are saved.
use std::collections::BTreeMap;

use physics::{Aabb, BlockWorld, CollisionWorld};
use protocol::S2C;
use world::{Fnv64, World, HEIGHT, MIN_Y};

use crate::{arrow::look_direction, inventory::Screen, lava_bounds, mob::sample, GameMode, Server};

const RADIUS: f64 = 0.125;
const LIFETIME: u8 = 100;
const COOLDOWN: u8 = 4;
const LIMIT: usize = 256;
const HATCH_SALT: u64 = 0x4547_475f_4841_5443;

#[derive(Clone, Copy)]
pub(super) struct Egg {
    pos: [f64; 3],
    velocity: [f64; 3],
    age: u8,
}

enum Impact {
    Vanish,
    Block,
    Mob(u32),
}

fn chunk([x, _, z]: [f64; 3]) -> (i32, i32) {
    (x.floor() as i32 >> 4, z.floor() as i32 >> 4)
}

impl Egg {
    pub(super) fn chunk(&self) -> (i32, i32) {
        chunk(self.pos)
    }

    fn at(&self, time: f64) -> [f64; 3] {
        std::array::from_fn(|axis| self.pos[axis] + time * self.velocity[axis])
    }

    // Sweep the egg's box by expanding the target and tracing the egg's center.
    fn entry(&self, bounds: Aabb, radius: f64) -> Option<f64> {
        let mut enter: f64 = 0.0;
        let mut exit = f64::INFINITY;
        for (axis, velocity) in self.velocity.into_iter().enumerate() {
            let min = bounds.min[axis] - radius - self.pos[axis];
            let max = bounds.max[axis] + radius - self.pos[axis];
            if velocity == 0.0 {
                if min >= 0.0 || max <= 0.0 {
                    return None;
                }
            } else {
                let (a, b) = (min / velocity, max / velocity);
                enter = enter.max(a.min(b));
                exit = exit.min(a.max(b));
            }
        }
        (enter <= 1.0 && enter < exit).then_some(enter)
    }

    fn environment_hit(&self, world: &World, end: [f64; 3]) -> Option<(f64, Impact)> {
        let lo: [i32; 3] =
            std::array::from_fn(|i| (self.pos[i].min(end[i]) - RADIUS).floor() as i32);
        let hi: [i32; 3] =
            std::array::from_fn(|i| (self.pos[i].max(end[i]) + RADIUS).floor() as i32);
        let mut hit = (end[1] < f64::from(MIN_Y)).then(|| {
            (
                (f64::from(MIN_Y) - self.pos[1]) / self.velocity[1],
                Impact::Vanish,
            )
        });
        let mut record = |time: f64, impact: Impact| {
            if hit.as_ref().is_none_or(|(old, previous)| {
                time < *old || (time == *old && matches!(previous, Impact::Block))
            }) {
                hit = Some((time, impact));
            }
        };

        let (start_x, start_z) = self.chunk();
        let (end_x, end_z) = chunk(end);
        for cx in start_x.min(end_x)..=start_x.max(end_x) {
            for cz in start_z.min(end_z)..=start_z.max(end_z) {
                if !world.chunks.contains_key(&(cx, cz)) {
                    let mut column = Aabb {
                        min: [f64::from(cx * 16), f64::NEG_INFINITY, f64::from(cz * 16)],
                        max: [
                            f64::from(cx * 16 + 16),
                            f64::INFINITY,
                            f64::from(cz * 16 + 16),
                        ],
                    };
                    // A center exactly on a chunk boundary belongs to its floored chunk.
                    for axis in [0, 2] {
                        if self.velocity[axis] == 0.0 {
                            column.min[axis] = f64::NEG_INFINITY;
                            column.max[axis] = f64::INFINITY;
                        }
                    }
                    if let Some(time) = self.entry(column, 0.0) {
                        record(time, Impact::Vanish);
                    } else if (cx, cz) == (end_x, end_z) {
                        record(1.0, Impact::Vanish);
                    }
                }
            }
        }

        let collisions = BlockWorld(|x, y, z| world.get_block(x, y, z));
        for x in lo[0]..=hi[0] {
            for z in lo[2]..=hi[2] {
                if !world.chunks.contains_key(&(x >> 4, z >> 4)) {
                    continue;
                }
                // Fences can extend into the cell above their owner.
                for y in (lo[1] - 1).max(MIN_Y)..=hi[1].min(MIN_Y + HEIGHT - 1) {
                    if let Some(bounds) = lava_bounds(world, x, y, z) {
                        if let Some(time) = self.entry(bounds, RADIUS) {
                            record(time, Impact::Vanish);
                        }
                    } else {
                        collisions.collision_boxes(x, y, z, &mut |bounds| {
                            if let Some(time) = self.entry(bounds, RADIUS) {
                                record(time, Impact::Block);
                            }
                        });
                    }
                }
            }
        }
        hit
    }
}

impl Server {
    pub(super) fn throw_egg(&mut self, player: u32) {
        let client = &self.clients[&player];
        if client.egg_cooldown != 0 || client.inventory.screen != Screen::None {
            return;
        }
        let Some(id) = self.allocate_entity_id() else {
            return;
        };
        let client = self.clients.get_mut(&player).unwrap();
        if self.game_mode == GameMode::Survival {
            client
                .inventory
                .take_one(usize::from(client.inventory.selected()));
            client.inventory_dirty = true;
        }
        client.egg_cooldown = COOLDOWN;
        let mut pos = client.pos;
        pos[1] += physics::EYE_HEIGHT;
        let velocity = look_direction(client.yaw, client.pitch).map(|axis| axis * 1.2);
        if self.eggs.len() >= LIMIT {
            self.eggs.pop_first();
        }
        self.eggs.insert(
            id,
            Egg {
                pos,
                velocity,
                age: 0,
            },
        );
    }

    fn egg_sound(&mut self, pos: [f64; 3], broken: bool) {
        let bytes = S2C::EggSound { pos, broken }.encode();
        let chunk = chunk(pos);
        for (&id, client) in &self.clients {
            if client.joined && client.sent.contains(&chunk) {
                self.outbox.push((id, bytes.clone()));
            }
        }
    }

    pub(super) fn tick_eggs(&mut self) {
        for client in self.clients.values_mut() {
            client.egg_cooldown = client.egg_cooldown.saturating_sub(1);
        }
        let mut eggs = std::mem::take(&mut self.eggs);
        eggs.retain(|&id, egg| self.tick_egg(id, egg));
        self.eggs = eggs;
    }

    fn tick_egg(&mut self, id: u32, egg: &mut Egg) -> bool {
        if egg.age == 0 {
            self.egg_sound(egg.pos, false);
        }
        egg.age += 1;
        if egg.age >= LIFETIME
            || egg.pos[1] < f64::from(MIN_Y)
            || !self.world.chunks.contains_key(&egg.chunk())
        {
            return false;
        }

        let end = egg.at(1.0);
        let obstacle = egg.environment_hit(&self.world, end);
        let target = self
            .mobs
            .iter()
            .filter(|(_, mob)| mob.health != 0)
            .filter_map(|(&mob, target)| {
                let time = egg.entry(target.bounds(), RADIUS)?;
                obstacle
                    .as_ref()
                    .is_none_or(|(wall, _)| time < *wall)
                    .then_some((time, mob))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let impact = target
            .map(|(time, mob)| (time, Impact::Mob(mob)))
            .or(obstacle);
        let Some((time, impact)) = impact else {
            egg.pos = end;
            egg.velocity = egg.velocity.map(|axis| axis * 0.99);
            egg.velocity[1] -= 0.03;
            return true;
        };
        match impact {
            Impact::Vanish => return false,
            Impact::Block => {}
            Impact::Mob(target) => self.mobs.get_mut(&target).unwrap().hit_by_egg(
                egg.velocity,
                self.seed,
                target,
                self.game_time,
            ),
        }
        let pos = egg.at(time);
        self.egg_sound(pos, true);
        if sample(self.seed, id, self.game_time, HATCH_SALT).is_multiple_of(8) {
            self.hatch_chicken(pos);
        }
        false
    }

    pub(super) fn sync_eggs(&mut self) {
        for (&id, client) in self.clients.iter_mut().filter(|(_, c)| c.joined) {
            let visible: BTreeMap<_, _> = self
                .eggs
                .iter()
                .filter(|(_, egg)| client.sent.contains(&egg.chunk()))
                .map(|(&id, egg)| (id, egg.pos))
                .collect();
            for &egg in client
                .visible_eggs
                .keys()
                .filter(|egg| !visible.contains_key(egg))
            {
                self.outbox
                    .push((id, S2C::EntityRemove { id: egg }.encode()));
            }
            for (&egg, &pos) in &visible {
                let [x, y, z] = pos;
                let packet = match client.visible_eggs.get(&egg) {
                    None => S2C::EggSpawn { id: egg, pos },
                    Some(&old) if old != pos => S2C::EntityMove { id: egg, x, y, z },
                    Some(_) => continue,
                };
                self.outbox.push((id, packet.encode()));
            }
            client.visible_eggs = visible;
        }
    }

    pub(super) fn hash_eggs(&self, hash: &mut Fnv64) {
        if !self.eggs.is_empty() {
            hash.bytes(b"eggs");
            hash.i64(self.eggs.len() as i64);
            for (&id, egg) in &self.eggs {
                hash.bytes(&id.to_be_bytes());
                for axis in egg.pos.into_iter().chain(egg.velocity) {
                    hash.bytes(&axis.to_bits().to_be_bytes());
                }
                hash.u8(egg.age);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{mob::MobKind, Stack};
    use protocol::{C2S, PROTOCOL_VERSION};
    use world::{blocks, items, Chunk};
    use worldgen::Generator;

    fn server() -> Server {
        let mut server = Server::new(2026, Generator::Flat);
        server.world.insert_chunk(Chunk::empty(0, 0));
        server
    }

    fn join(server: &mut Server, id: u32, pos: [f64; 3]) {
        server.connect_at(id, true, Some(pos), None);
        server.apply(
            id,
            C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            },
        );
        server.clients.get_mut(&id).unwrap().sent.insert((0, 0));
    }

    fn insert(server: &mut Server, pos: [f64; 3], velocity: [f64; 3]) -> u32 {
        let id = server.allocate_entity_id().unwrap();
        server.eggs.insert(
            id,
            Egg {
                pos,
                velocity,
                age: 0,
            },
        );
        id
    }

    fn sounds(server: &mut Server) -> Vec<([f64; 3], bool)> {
        server
            .take_outbox()
            .into_iter()
            .filter_map(|(_, packet)| match S2C::decode(&packet).unwrap() {
                S2C::EggSound { pos, broken } => Some((pos, broken)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn use_item_throws_from_the_eye_and_obeys_inventory_and_four_tick_cooldown() {
        let item = items::by_name("egg").unwrap();
        for mode in [GameMode::Creative, GameMode::Survival] {
            let mut s = server();
            s.game_mode = mode;
            join(&mut s, 1, [4.5, 4.0, 4.5]);
            let inv = &mut s.clients.get_mut(&1).unwrap().inventory;
            inv.set(0, None).unwrap();
            inv.set(
                1,
                Some(Stack {
                    item,
                    count: 2,
                    damage: 0,
                }),
            )
            .unwrap();
            s.apply(1, C2S::UseItem);
            assert!(s.eggs.is_empty(), "an egg in another slot cannot be thrown");
            s.apply(1, C2S::SelectSlot { slot: 1 });
            s.apply(1, C2S::UseItem);
            let egg = s.eggs.values().next().unwrap();
            assert_eq!(egg.pos, [4.5, 4.0 + physics::EYE_HEIGHT, 4.5]);
            assert_eq!(egg.velocity, [0.0, 0.0, 1.2]);
            let count = if mode == GameMode::Survival { 1 } else { 2 };
            assert_eq!(
                s.clients[&1].inventory.selected_stack().unwrap().count,
                count
            );
            for _ in 0..4 {
                s.apply(1, C2S::UseItem);
                assert_eq!(s.eggs.len(), 1);
                assert_eq!(
                    s.clients[&1].inventory.selected_stack().unwrap().count,
                    count
                );
                s.tick_eggs();
            }
            s.apply(1, C2S::UseItem);
            assert_eq!(s.eggs.len(), 2);
            assert_eq!(
                s.clients[&1]
                    .inventory
                    .selected_stack()
                    .map(|stack| stack.count),
                (mode == GameMode::Creative).then_some(2)
            );
        }
    }

    #[test]
    fn flight_uses_drag_and_gravity_and_expires_at_tick_one_hundred() {
        let mut s = server();
        let id = insert(&mut s, [3.0, 10.0, 3.0], [1.2, 0.0, 0.0]);
        for (x, y) in [
            (4.2, 10.0),
            (5.388, 9.97),
            (6.56412, 9.9103),
            (7.7284788, 9.821197),
        ] {
            s.tick_eggs();
            let pos = s.eggs[&id].pos;
            assert!((pos[0] - x).abs() < 1e-12);
            assert!((pos[1] - y).abs() < 1e-12);
            assert_eq!(pos[2], 3.0);
        }
        let high = insert(&mut s, [3.0, 400.0, 3.0], [0.0, 1.2, 0.0]);
        for _ in 0..99 {
            s.tick_eggs();
        }
        assert_eq!(s.eggs[&high].age, 99);
        s.tick_eggs();
        assert!(s.eggs.is_empty());
    }

    #[test]
    fn egg_box_hits_solids_and_water_does_not_slow_it_but_lava_removes_it() {
        for (block, keeps, breaks) in [
            (blocks::STONE, false, true),
            (blocks::WATER, true, false),
            (blocks::LAVA, false, false),
        ] {
            let mut s = server();
            join(&mut s, 1, [6.0, 4.0, 4.0]);
            s.world.set_block(3, 2, 3, block);
            let start = [2.25, 2.5, 3.5];
            let id = insert(&mut s, start, [1.2, 0.0, 0.0]);
            s.tick_eggs();
            assert_eq!(s.eggs.contains_key(&id), keeps);
            let mut expected = vec![(start, false)];
            if breaks {
                expected.push(([2.875, 2.5, 3.5], true));
            }
            assert_eq!(sounds(&mut s), expected);
            if keeps {
                assert_eq!(s.eggs[&id].pos, [3.45, 2.5, 3.5]);
                assert_eq!(s.eggs[&id].velocity, [1.188, -0.03, 0.0]);
            }
        }

        let mut s = server();
        s.world.set_block(3, 2, 3, blocks::STONE);
        let grazing = insert(&mut s, [2.25, 2.5, 2.9], [1.2, 0.0, 0.0]);
        let misses = insert(&mut s, [2.25, 2.5, 2.875], [1.2, 0.0, 0.0]);
        let unloaded = insert(&mut s, [15.5, 2.0, 4.0], [1.2, 0.0, 0.0]);
        let below_world = insert(&mut s, [4.0, f64::from(MIN_Y) + 0.5, 4.0], [0.0, -1.2, 0.0]);
        s.tick_eggs();
        assert!(!s.eggs.contains_key(&grazing));
        assert!(s.eggs.contains_key(&misses));
        assert!(!s.eggs.contains_key(&unloaded));
        assert!(!s.eggs.contains_key(&below_world));
    }

    #[test]
    fn horizontal_egg_sweep_checks_the_lava_surface_against_the_box() {
        let level_three = blocks::FLOWING_LAVA + 2;
        for (state, above, y, survives) in [
            (level_three, blocks::AIR, 2.875, true),
            (level_three, blocks::AIR, 2.75, true),
            // The center clears the surface, but the bottom of the box enters it.
            (level_three, blocks::AIR, 2.6875, false),
            (level_three, blocks::AIR, 2.5, false),
            (blocks::LAVA, blocks::AIR, 3.03125, true),
            // The egg's top only grazes the upper cell. It hits the lower one.
            (level_three, blocks::FLOWING_LAVA, 2.875, false),
        ] {
            let mut s = server();
            s.world.set_block(3, 2, 3, state);
            s.world.set_block(3, 3, 3, above);
            let id = insert(&mut s, [2.25, y, 3.5], [2.0, 0.0, 0.0]);
            s.tick_eggs();
            assert_eq!(
                s.eggs.contains_key(&id),
                survives,
                "state {state}, above {above}, center y {y}"
            );
        }
    }

    #[test]
    fn egg_passes_through_players_and_pushes_the_first_mob_without_damage() {
        let mut s = server();
        join(&mut s, 1, [3.5, 1.0, 2.5]);
        join(&mut s, 2, [3.5, 1.0, 3.2]);
        s.spawn_mob(MobKind::Cow, [3.5, 1.6, 4.1]);
        let first = 1;
        s.spawn_mob(MobKind::Cow, [3.5, 1.6, 4.1]);
        s.game_mode = GameMode::Survival;
        let inventory = &mut s.clients.get_mut(&1).unwrap().inventory;
        inventory
            .set(
                0,
                Some(Stack {
                    item: items::by_name("egg").unwrap(),
                    count: 1,
                    damage: 0,
                }),
            )
            .unwrap();
        s.apply(1, C2S::UseItem);
        s.tick_eggs();
        assert!(s.eggs.is_empty());
        assert_eq!(s.mobs[&first].health, 10);
        assert_eq!(s.mobs[&first].hurt_ticks, 0);
        assert_eq!(s.mobs[&first].velocity(), [0.0, 0.2, 0.3]);
        assert_eq!(s.mobs[&2].velocity(), [0.0; 3]);
        for client in s.clients.values() {
            assert_eq!(client.health.vitals.health, 20);
        }
    }

    #[test]
    fn hatching_is_deterministic_at_one_eighth_and_respects_the_cap_and_clearance() {
        let run = || {
            let mut s = server();
            s.world.set_block(4, 0, 4, blocks::STONE);
            let mut results = Vec::new();
            for _ in 0..2048 {
                insert(&mut s, [4.5, 2.0, 4.5], [0.0, -1.2, 0.0]);
                s.tick_eggs();
                assert!(s.eggs.is_empty());
                results.push(!s.mobs.is_empty());
                if let Some(mob) = s.mobs.values().next() {
                    assert_eq!(s.mobs.len(), 1);
                    assert_eq!(mob.kind, MobKind::Chicken);
                    assert_eq!(mob.pos(), [4.5, 1.125, 4.5]);
                }
                s.mobs.clear();
            }
            results
        };
        let results = run();
        assert_eq!(results, run());
        assert!((215..=300).contains(&results.into_iter().filter(|&hatched| hatched).count()));

        for full in [true, false] {
            let mut s = server();
            join(&mut s, 1, [9.0, 2.0, 9.0]);
            s.world.set_block(4, 0, 4, blocks::STONE);
            if full {
                for i in 0..8 {
                    s.spawn_mob(MobKind::Cow, [f64::from(i) + 0.5, 2.0, 12.5]);
                }
            } else {
                // The egg can strike the floor beside this wall, but the wider chicken cannot fit.
                s.world.set_block(5, 1, 4, blocks::STONE);
            }
            while !sample(s.seed, s.next_entity_id, s.game_time, HATCH_SALT).is_multiple_of(8) {
                s.allocate_entity_id().unwrap();
            }
            insert(&mut s, [4.85, 2.0, 4.5], [0.0, -1.2, 0.0]);
            s.tick_eggs();
            assert!(s.eggs.is_empty());
            assert_eq!(s.mobs.len(), if full { 8 } else { 0 });
        }
    }

    #[test]
    fn oldest_eggs_are_evicted_and_flying_eggs_are_not_saved() {
        let mut s = server();
        join(&mut s, 1, [4.5, 4.0, 4.5]);
        let inventory = &mut s.clients.get_mut(&1).unwrap().inventory;
        inventory
            .set(
                0,
                Some(Stack {
                    item: items::by_name("egg").unwrap(),
                    count: 1,
                    damage: 0,
                }),
            )
            .unwrap();
        s.game_mode = GameMode::Creative;
        for _ in 0..LIMIT {
            insert(&mut s, [4.5, 4.0, 4.5], [0.0, 0.0, 1.2]);
        }
        s.apply(1, C2S::UseItem);
        assert_eq!(s.eggs.len(), LIMIT);
        assert!(!s.eggs.contains_key(&1));
        assert!(s.eggs.contains_key(&(LIMIT as u32 + 1)));

        s.spawn_item(
            items::by_name("egg").unwrap(),
            1,
            [4.5, 4.0, 4.5],
            [0.0; 3],
            0,
        );
        s.world.chunks.get_mut(&(0, 0)).unwrap().dirty = true;
        let (cx, cz, bytes) = s.take_dirty().unwrap();
        let mut restored = Server::new(2026, Generator::Flat);
        assert!(restored.load_chunk(cx, cz, &bytes));
        assert!(restored.eggs.is_empty());
        assert_eq!(restored.entities.len(), 1);
    }

    #[test]
    fn normal_ticks_send_egg_spawn_move_break_sound_and_removal() {
        let mut s = server();
        s.game_mode = GameMode::Creative;
        join(&mut s, 1, [4.5, 4.0, 4.5]);
        s.apply(
            1,
            C2S::CreativeSetSlot {
                slot: 0,
                item: items::by_name("egg").unwrap(),
                count: 1,
            },
        );
        s.world.set_block(4, 5, 8, blocks::STONE);
        s.take_outbox();
        let id = s.next_entity_id;
        let packets = |s: &mut Server| {
            s.take_outbox()
                .into_iter()
                .map(|(viewer, packet)| {
                    assert_eq!(viewer, 1);
                    S2C::decode(&packet).unwrap()
                })
                .collect::<Vec<_>>()
        };

        s.handle_packet(1, &C2S::UseItem.encode());
        s.tick();
        let launch = packets(&mut s);
        assert!(launch.contains(&S2C::EggSound {
            pos: [4.5, 5.62, 4.5],
            broken: false
        }));
        assert!(launch.contains(&S2C::EggSpawn {
            id,
            pos: [4.5, 5.62, 5.7]
        }));

        s.tick();
        assert!(packets(&mut s)
            .iter()
            .any(|packet| { matches!(packet, S2C::EntityMove { id: moved, .. } if *moved == id) }));

        for _ in 0..2 {
            s.tick();
            let impact = packets(&mut s);
            if impact.contains(&S2C::EntityRemove { id }) {
                assert!(impact
                    .iter()
                    .any(|packet| matches!(packet, S2C::EggSound { broken: true, .. })));
                assert!(!s.eggs.contains_key(&id));
                return;
            }
        }
        panic!("egg never hit the wall");
    }

    #[test]
    fn state_hash_covers_egg_motion_age_and_cooldown() {
        let mut s = server();
        join(&mut s, 1, [4.5, 4.0, 4.5]);
        let idle = s.state_hash();
        s.clients.get_mut(&1).unwrap().egg_cooldown = 4;
        assert_ne!(s.state_hash(), idle);
        s.clients.get_mut(&1).unwrap().egg_cooldown = 0;
        assert_eq!(s.state_hash(), idle);
        let id = insert(&mut s, [4.5, 4.0, 4.5], [0.0, 0.0, 1.2]);
        let hash = s.state_hash();
        let original = s.eggs[&id];
        for change in [
            |egg: &mut Egg| egg.pos[0] += 0.125,
            |egg: &mut Egg| egg.velocity[0] = 0.1,
            |egg: &mut Egg| egg.age += 1,
        ] {
            let mut egg = original;
            change(&mut egg);
            s.eggs.insert(id, egg);
            assert_ne!(s.state_hash(), hash);
        }
    }
}
