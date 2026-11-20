//! Dropped item entities, processed in ascending world-local ID order.
use physics::{Aabb, BlockWorld, CollisionWorld};
use world::World;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EntityKind {
    Item = 0,
}
#[derive(Clone, Debug)]
pub struct Entity {
    pub kind: EntityKind,
    pub pos: [f64; 3],
    pub velocity: [f64; 3],
    pub item: u16,
    pub count: u8,
    pub age: u32,
    pub pickup_delay: u32,
    pub on_ground: bool,
}
impl Entity {
    pub fn bounds(&self) -> Aabb {
        let [x, y, z] = self.pos;
        Aabb {
            min: [x - 0.125, y, z - 0.125],
            max: [x + 0.125, y + 0.25, z + 0.125],
        }
    }
    pub fn chunk(&self) -> (i32, i32) {
        (
            (self.pos[0].floor() as i32) >> 4,
            (self.pos[2].floor() as i32) >> 4,
        )
    }
    pub fn tick(&mut self, world: &World) {
        self.age = self.age.saturating_add(1);
        self.pickup_delay = self.pickup_delay.saturating_sub(1);
        let bounds = self.bounds();
        // Below/above world bounds are empty, while unknown neighboring chunks are solid.
        let collisions = BlockWorld(|x, y, z| {
            if !(world::MIN_Y..world::MIN_Y + world::HEIGHT).contains(&y) {
                Some(world::blocks::AIR)
            } else {
                world.get_block(x, y, z)
            }
        });
        let mut embedded = false;
        for x in bounds.min[0].floor() as i32..=bounds.max[0].floor() as i32 {
            for y in bounds.min[1].floor() as i32 - 1..=bounds.max[1].floor() as i32 {
                for z in bounds.min[2].floor() as i32..=bounds.max[2].floor() as i32 {
                    collisions.collision_boxes(x, y, z, &mut |b| embedded |= bounds.intersects(b));
                }
            }
        }
        if embedded {
            self.pos[1] += 0.1;
            self.on_ground = false;
            return;
        }
        self.velocity[1] -= 0.04;
        let actual = physics::resolve(&collisions, bounds, self.velocity);
        self.on_ground = self.velocity[1] < 0.0 && actual[1] != self.velocity[1];
        for (a, delta) in actual.into_iter().enumerate() {
            self.pos[a] += delta;
            if delta != self.velocity[a] {
                self.velocity[a] = 0.0;
            }
            self.velocity[a] *= if a != 1 && self.on_ground { 0.6 } else { 0.98 };
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{GameMode, Server};
    use protocol::{C2S, PROTOCOL_VERSION, S2C};
    use world::{blocks, Chunk};
    use worldgen::Generator;
    fn server() -> Server {
        let mut s = Server::new(5, Generator::Flat);
        s.world.chunks.insert((0, 0), Chunk::empty(0, 0));
        s
    }
    fn item(s: &mut Server, pos: [f64; 3], velocity: [f64; 3], delay: u32) -> u32 {
        let id = s.next_entity_id;
        s.spawn_item(1, 1, pos, velocity, delay);
        id
    }
    fn ground(s: &mut Server) {
        for x in 0..16 {
            for z in 0..16 {
                s.world.set_block(x, 0, z, blocks::STONE);
            }
        }
    }
    #[test]
    fn falls_lands_and_horizontal_friction_and_wall_stop() {
        let mut s = server();
        ground(&mut s);
        let id = item(&mut s, [2.0, 3.0, 2.0], [0.1, 0.0, 0.0], 20);
        for _ in 0..200 {
            s.tick_entities();
        }
        let e = &s.entities[&id];
        assert_eq!(e.pos[1], 1.0);
        assert!(e.on_ground);
        assert_eq!(e.velocity[1], 0.0);
        assert!(e.velocity[0].abs() < 1e-30);
        s.world.set_block(5, 1, 2, blocks::STONE);
        let id = item(&mut s, [4.8, 1.0, 2.5], [0.3, 0.0, 0.0], 20);
        s.tick_entities();
        let e = &s.entities[&id];
        assert_eq!(e.pos[0], 4.875);
        assert_eq!(e.velocity[0], 0.0);
    }
    #[test]
    fn embedded_rises_and_missing_chunk_freezes() {
        let mut s = server();
        s.world.set_block(2, 2, 2, blocks::STONE);
        let id = item(&mut s, [2.5, 2.0, 2.5], [0.2, 0.0, 0.0], 40);
        s.tick_entities();
        assert_eq!(s.entities[&id].pos, [2.5, 2.1, 2.5]);
        for _ in 0..12 {
            s.tick_entities();
        }
        assert!(s.entities[&id].pos[1] >= 3.0);
        let id = item(&mut s, [20.0, 2.0, 2.0], [1.0, 1.0, 1.0], 40);
        s.tick_entities();
        assert_eq!(s.entities[&id].age, 0);
        assert_eq!(s.entities[&id].pickup_delay, 40);
        assert_eq!(s.entities[&id].pos, [20.0, 2.0, 2.0]);
    }
    #[test]
    fn pickup_delay_range_partial_full_and_client_order() {
        let mut s = server();
        ground(&mut s);
        s.connect(2);
        s.connect(1);
        for c in s.clients.values_mut() {
            c.joined = true;
            c.pos = [2.5, 1.0, 2.5];
        }
        s.clients.get_mut(&1).unwrap().inventory = crate::Inventory::default();
        let id = item(&mut s, [2.5, 1.0, 2.5], [0.0; 3], 2);
        s.tick_entities();
        assert!(s.entities.contains_key(&id));
        s.tick_entities();
        assert!(!s.entities.contains_key(&id));
        assert_eq!(s.clients[&1].inventory.selected_stack().unwrap().count, 1);
        s.clients.remove(&2);
        let inv = &mut s.clients.get_mut(&1).unwrap().inventory;
        inv.add(1, 36 * 64 - 2);
        let id = item(&mut s, [2.5, 1.0, 2.5], [0.0; 3], 0);
        s.entities.get_mut(&id).unwrap().count = 3;
        s.tick_entities();
        assert_eq!(s.entities[&id].count, 2);
        s.tick_entities();
        assert_eq!(s.entities[&id].count, 2);
        let id = item(&mut s, [8.0, 1.0, 2.5], [0.0; 3], 0);
        s.clients.get_mut(&1).unwrap().inventory = crate::Inventory::default();
        s.tick_entities();
        assert!(s.entities.contains_key(&id));
    }
    #[test]
    fn merge_limits_lifetime_void_and_unload() {
        let mut s = server();
        ground(&mut s);
        s.game_time = 9;
        let a = item(&mut s, [2.5, 1.0, 2.5], [0.0; 3], 20);
        let b = item(&mut s, [3.0, 1.0, 2.5], [0.0; 3], 40);
        s.tick_entities();
        assert!(!s.entities.contains_key(&b));
        assert_eq!(s.entities[&a].count, 2);
        assert_eq!(s.entities[&a].pickup_delay, 39);
        let b = item(&mut s, [2.5, 1.0, 2.5], [0.0; 3], 20);
        s.entities.get_mut(&b).unwrap().count = 64;
        s.tick_entities();
        assert!(s.entities.contains_key(&b));
        for _ in 0..1024 {
            item(&mut s, [8.0, 2.0, 8.0], [0.0; 3], 40);
        }
        assert_eq!(s.entities.len(), 1024);
        assert!(!s.entities.contains_key(&a));
        s.entities.clear();
        let id = item(&mut s, [2.5, 1.0, 2.5], [0.0; 3], 0);
        s.entities.get_mut(&id).unwrap().age = 5999;
        s.tick_entities();
        assert!(s.entities.is_empty());
        item(&mut s, [2.5, (world::MIN_Y - 65) as f64, 2.5], [0.0; 3], 0);
        s.tick_entities();
        assert!(s.entities.is_empty());
        item(&mut s, [2.5, 1.0, 2.5], [0.0; 3], 0);
        s.world.chunks.get_mut(&(0, 0)).unwrap().dirty = false;
        s.unload_far_chunks();
        assert_eq!(s.entities.len(), 1);
        let (cx, cz, bytes) = s.take_dirty().unwrap();
        assert!(s.entities.is_empty());
        assert!(s.load_chunk(cx, cz, &bytes));
        assert_eq!(s.entities.len(), 1);
    }
    fn joined() -> Server {
        let mut s = Server::new(5, Generator::Flat);
        s.connect(1);
        s.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        s.tick();
        s.take_outbox();
        s
    }
    #[test]
    fn item_falling_into_lava_is_removed_for_clients() {
        let mut s = joined();
        let [x, y, z] = s.spawn().map(|v| v.floor() as i32);
        for state in [blocks::LAVA, blocks::FALLING_LAVA] {
            s.world.set_block(x, y, z, state);
            let id = item(
                &mut s,
                [f64::from(x) + 0.5, f64::from(y) + 1.1, f64::from(z) + 0.5],
                [0.0; 3],
                40,
            );
            s.tick();
            assert!(s.entities.contains_key(&id));
            assert!(s.take_outbox().iter().any(|(_, p)| {
                matches!(S2C::decode(p), Ok(S2C::EntitySpawn { id: spawned, .. }) if spawned == id)
            }));
            s.tick();
            assert!(!s.entities.contains_key(&id));
            assert!(s
                .take_outbox()
                .iter()
                .any(|(_, p)| { S2C::decode(p) == Ok(S2C::EntityRemove { id }) }));
        }
    }

    #[test]
    fn creative_breaks_do_not_drop_and_ids_never_wrap() {
        let mut s = joined();
        let [x, y, z] = s.spawn().map(|v| v.floor() as i32);
        s.world.set_block(x, y, z, blocks::STONE);
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x,
                y,
                z,
                state: blocks::AIR,
            }
            .encode(),
        );
        s.tick();
        assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
        assert!(s.entities.is_empty());
        s.next_entity_id = u32::MAX;
        item(&mut s, [2.5, 80.0, 2.5], [0.0; 3], 40);
        assert!(s.entities.contains_key(&u32::MAX));
        let before = s.clients[&1].inventory.clone();
        s.handle_packet(1, &C2S::DropItem { dir: [0.0; 3] }.encode());
        s.tick();
        assert_eq!(s.clients[&1].inventory, before);
        assert_eq!(s.entities.len(), 1);
    }

    #[test]
    fn drop_empty_invalid_normalized_and_both_modes() {
        for mode in [GameMode::Creative, GameMode::Survival] {
            let mut s = joined();
            s.game_mode = mode;
            s.handle_packet(
                1,
                &C2S::DropItem {
                    dir: [10.0, 0.0, 0.0],
                }
                .encode(),
            );
            s.tick();
            assert_eq!(s.entities.len(), 1);
            let e = s.entities.values().next().unwrap();
            assert_eq!(e.count, 1);
            assert_eq!(e.pickup_delay, 39);
            assert_eq!(e.velocity[0], 0.3 * 0.98);
            assert!(s.clients[&1].inventory.selected_stack().is_none());
            s.handle_packet(1, &C2S::DropItem { dir: [0.0; 3] }.encode());
            s.tick();
            assert_eq!(s.entities.len(), 1);
            assert_eq!(s.stats.packets_rejected, 0);
            s.handle_packet(
                1,
                &C2S::DropItem {
                    dir: [f32::NAN, 0.0, 0.0],
                }
                .encode(),
            );
            s.tick();
            assert_eq!(s.stats.packets_rejected, 1);
        }
    }
    #[test]
    fn visibility_packets_are_unique_and_hash_includes_entities() {
        let mut a = joined();
        let mut b = joined();
        a.connect(2);
        b.connect(2);
        for s in [&mut a, &mut b] {
            let c = s.clients.get_mut(&2).unwrap();
            c.joined = true;
            c.pos = [128.5, s.spawn[1], 128.5];
            c.view = 2;
        }
        let mut pos = a.spawn();
        pos[1] += 2.0;
        let id = item(&mut a, pos, [0.0; 3], 40);
        item(&mut b, pos, [0.0; 3], 40);
        assert_eq!(a.state_hash(), b.state_hash());
        a.tick();
        b.tick();
        assert_eq!(a.state_hash(), b.state_hash());
        let packets = a.take_outbox();
        assert_eq!(
            packets
                .iter()
                .filter(|(c, p)| *c == 1 && matches!(S2C::decode(p), Ok(S2C::EntitySpawn { .. })))
                .count(),
            1
        );
        assert!(!packets
            .iter()
            .any(|(c, p)| *c == 2 && matches!(S2C::decode(p), Ok(S2C::EntitySpawn { .. }))));
        a.entities.get_mut(&id).unwrap().count = 2;
        a.tick();
        let packets = a.take_outbox();
        assert_eq!(
            packets
                .iter()
                .filter(|(_, p)| matches!(S2C::decode(p), Ok(S2C::EntityCount { .. })))
                .count(),
            1
        );
        assert_eq!(
            packets
                .iter()
                .filter(|(_, p)| matches!(S2C::decode(p), Ok(S2C::EntityMove { .. })))
                .count(),
            1
        );
        assert_ne!(a.state_hash(), b.state_hash());
        a.clients.get_mut(&1).unwrap().sent.clear();
        a.sync_entities();
        assert_eq!(
            a.take_outbox()
                .iter()
                .filter(|(_, p)| matches!(S2C::decode(p), Ok(S2C::EntityRemove { .. })))
                .count(),
            1
        );
    }
}
