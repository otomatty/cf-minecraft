//! Transient skeleton projectiles and swept collision against blocks and players.
use std::collections::BTreeMap;

use physics::{Aabb, BlockWorld, CollisionWorld, Player};
use protocol::{DeathCause, S2C};
use world::{Fnv64, World};

use crate::{health::VOID_Y, GameMode, Server};

const FLIGHT_LIFETIME: u8 = 200;
const EMBEDDED_LIFETIME: u8 = 100;
const DAMAGE: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ArrowMotion {
    pub pos: [f64; 3],
    pub velocity: [f64; 3],
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Arrow {
    motion: ArrowMotion,
    age: u8,
    embedded_ticks: Option<u8>,
}

impl Arrow {
    pub(crate) fn aimed(pos: [f64; 3], mut target: [f64; 3]) -> Self {
        let dx = target[0] - pos[0];
        let dz = target[2] - pos[2];
        target[1] += (dx * dx + dz * dz).sqrt() * 0.08;
        let delta = difference(target, pos);
        let length = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt();
        let velocity = if length == 0.0 {
            [0.0, 1.2, 0.0]
        } else {
            delta.map(|v| v * (1.2 / length))
        };
        Self {
            motion: ArrowMotion { pos, velocity },
            age: 0,
            embedded_ticks: None,
        }
    }

    pub(crate) fn chunk(&self) -> (i32, i32) {
        let [x, _, z] = self.motion.pos.map(|v| v.floor() as i32);
        (x >> 4, z >> 4)
    }

    fn tick(&mut self, world: &World, players: impl Iterator<Item = (u32, [f64; 3])>) -> ArrowTick {
        self.age += 1;
        if self.age >= FLIGHT_LIFETIME
            || self.motion.pos[1] < VOID_Y
            || !world.chunks.contains_key(&self.chunk())
        {
            return ArrowTick::Remove;
        }
        if let Some(ticks) = &mut self.embedded_ticks {
            *ticks += 1;
            return if *ticks >= EMBEDDED_LIFETIME {
                ArrowTick::Remove
            } else {
                ArrowTick::Keep
            };
        }

        let ArrowMotion { pos, velocity } = self.motion;
        let end = std::array::from_fn(|axis| pos[axis] + velocity[axis]);
        let delta = difference(end, pos);
        let void_exit = if end[1] < VOID_Y {
            (VOID_Y - pos[1]) / delta[1]
        } else {
            1.0
        };
        let obstacle = trace_blocks(world, pos, end).filter(|hit| hit.time <= void_exit);
        // The block wins a tie. Players at the same distance are ordered by ID.
        let player = players
            .filter_map(|(id, feet)| {
                let time = segment_entry(pos, delta, Player::new(feet).bounds())?;
                (time <= void_exit && obstacle.as_ref().is_none_or(|hit| time < hit.time))
                    .then_some((time, id))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        if let Some((_, id)) = player {
            return ArrowTick::Hit(id);
        }
        if let Some(hit) = obstacle {
            if hit.unloaded {
                return ArrowTick::Remove;
            }
            self.motion.pos = std::array::from_fn(|axis| pos[axis] + delta[axis] * hit.time);
            // Keep the impact direction for rendering, including when a client joins later.
            self.embedded_ticks = Some(0);
        } else {
            self.motion.pos = end;
            self.motion.velocity = velocity.map(|v| v * 0.99);
            self.motion.velocity[1] -= 0.05;
        }
        if self.motion.pos[1] < VOID_Y || !world.chunks.contains_key(&self.chunk()) {
            ArrowTick::Remove
        } else {
            ArrowTick::Keep
        }
    }
}

enum ArrowTick {
    Keep,
    Remove,
    Hit(u32),
}

fn difference(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|axis| a[axis] - b[axis])
}

fn segment_entry(start: [f64; 3], delta: [f64; 3], bounds: Aabb) -> Option<f64> {
    if (0..3).all(|axis| (bounds.min[axis]..=bounds.max[axis]).contains(&start[axis])) {
        return Some(0.0);
    }
    let (distance, _) = physics::ray_box(start, delta, bounds)?;
    (distance <= 1.0).then_some(distance)
}

struct BlockHit {
    time: f64,
    unloaded: bool,
}

pub(crate) fn clear_sight(world: &World, start: [f64; 3], end: [f64; 3]) -> bool {
    trace_blocks(world, start, end).is_none()
}

fn trace_blocks(world: &World, start: [f64; 3], end: [f64; 3]) -> Option<BlockHit> {
    let delta = difference(end, start);
    let mut cell = start.map(|v| v.floor() as i32);
    let goal = end.map(|v| v.floor() as i32);
    let step: [i32; 3] = std::array::from_fn(|axis| if goal[axis] > cell[axis] { 1 } else { -1 });
    let collisions = BlockWorld(|x, y, z| world.get_block(x, y, z));
    let mut entry = 0.0;
    let mut nearest = None::<f64>;
    loop {
        if nearest.is_some_and(|time| time < entry) {
            break;
        }
        let [x, y, z] = cell;
        if !world.chunks.contains_key(&(x >> 4, z >> 4)) {
            return Some(BlockHit {
                time: entry,
                unloaded: true,
            });
        }
        // Fences extend into the cell above their owner.
        for owner_y in [y, y - 1] {
            collisions.collision_boxes(x, owner_y, z, &mut |bounds| {
                if let Some(time) = segment_entry(start, delta, bounds) {
                    if nearest.is_none_or(|old| time < old) {
                        nearest = Some(time);
                    }
                }
            });
        }
        if cell == goal {
            break;
        }
        let crossings: [f64; 3] = std::array::from_fn(|axis| {
            if cell[axis] == goal[axis] {
                f64::INFINITY
            } else {
                let boundary = f64::from(cell[axis]) + f64::from(i32::from(step[axis] > 0));
                (boundary - start[axis]) / delta[axis]
            }
        });
        entry = crossings[0].min(crossings[1]).min(crossings[2]);
        // Step tied axes together so a corner graze does not visit a side cell.
        for axis in 0..3 {
            if crossings[axis] == entry {
                cell[axis] += step[axis];
            }
        }
    }
    nearest.map(|time| BlockHit {
        time,
        unloaded: false,
    })
}

impl Server {
    pub(crate) fn tick_arrows(&mut self) {
        let mut deaths = Vec::new();
        self.arrows.retain(|_, arrow| {
            let players = self.clients.iter().filter_map(|(&id, client)| {
                (self.game_mode == GameMode::Survival
                    && client.joined
                    && !client.health.vitals.dead)
                    .then_some((id, client.pos))
            });
            match arrow.tick(&self.world, players) {
                ArrowTick::Keep => true,
                ArrowTick::Remove => false,
                ArrowTick::Hit(id) => {
                    let health = &mut self.clients.get_mut(&id).unwrap().health;
                    health.damage(DAMAGE, DeathCause::Arrow);
                    if health.vitals.dead {
                        deaths.push(id);
                    }
                    false
                }
            }
        });
        for id in deaths {
            self.finish_player_death(id);
        }
    }

    pub(crate) fn sync_arrows(&mut self) {
        for (&client, c) in self.clients.iter_mut().filter(|(_, c)| c.joined) {
            let visible: BTreeMap<_, _> = self
                .arrows
                .iter()
                .filter(|(_, arrow)| c.sent.contains(&arrow.chunk()))
                .map(|(&id, arrow)| (id, arrow.motion))
                .collect();
            for &id in c
                .visible_arrows
                .keys()
                .filter(|id| !visible.contains_key(id))
            {
                self.outbox
                    .push((client, S2C::EntityRemove { id }.encode()));
            }
            for (&id, &ArrowMotion { pos, velocity }) in &visible {
                let packet = match c.visible_arrows.get(&id) {
                    None => S2C::ArrowSpawn { id, pos, velocity },
                    Some(old) if *old != visible[&id] => S2C::ArrowMove { id, pos, velocity },
                    Some(_) => continue,
                };
                self.outbox.push((client, packet.encode()));
            }
            c.visible_arrows = visible;
        }
    }

    pub(crate) fn hash_arrows(&self, h: &mut Fnv64) {
        if !self.arrows.is_empty() {
            h.i64(self.arrows.len() as i64);
            for (&id, arrow) in &self.arrows {
                h.bytes(&id.to_be_bytes());
                for v in arrow.motion.pos.into_iter().chain(arrow.motion.velocity) {
                    h.bytes(&v.to_bits().to_be_bytes());
                }
                h.u8(arrow.age);
                h.u8(u8::from(arrow.embedded_ticks.is_some()));
                if let Some(ticks) = arrow.embedded_ticks {
                    h.u8(ticks);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{C2S, PROTOCOL_VERSION};
    use world::{blocks, Chunk};
    use worldgen::Generator;

    fn world() -> World {
        let mut world = World::default();
        world.chunks.insert((0, 0), Chunk::empty(0, 0));
        world
    }

    fn arrow(pos: [f64; 3], velocity: [f64; 3]) -> Arrow {
        Arrow {
            motion: ArrowMotion { pos, velocity },
            age: 0,
            embedded_ticks: None,
        }
    }

    #[test]
    fn launch_and_flight_use_the_aim_offset_drag_and_gravity() {
        let origin = [2.0, 2.74, 3.0];
        let mut arrow = Arrow::aimed(origin, [5.0, 2.62, 7.0]);
        let [vx, vy, vz] = arrow.motion.velocity;
        assert!((vx * vx + vy * vy + vz * vz - 1.2 * 1.2).abs() < 1e-12);
        assert!((vy / vx - 0.28 / 3.0).abs() < 1e-12);
        assert!((vz / vx - 4.0 / 3.0).abs() < 1e-12);
        assert!(matches!(
            arrow.tick(&world(), std::iter::empty()),
            ArrowTick::Keep
        ));
        assert_eq!(
            arrow.motion.pos,
            [origin[0] + vx, origin[1] + vy, origin[2] + vz]
        );
        assert_eq!(
            arrow.motion.velocity,
            [vx * 0.99, vy * 0.99 - 0.05, vz * 0.99]
        );
    }

    #[test]
    fn collision_uses_partial_shapes_fence_extensions_and_earliest_impact() {
        let mut world = world();
        world.set_block(3, 1, 3, blocks::OAK_SLAB);
        assert!(clear_sight(&world, [2.5, 1.75, 3.5], [5.5, 1.75, 3.5]));
        assert!(!clear_sight(&world, [2.5, 1.25, 3.5], [5.5, 1.25, 3.5]));
        world.set_block(3, 1, 3, blocks::OAK_FENCE);
        assert!(!clear_sight(&world, [2.5, 2.25, 3.5], [5.5, 2.25, 3.5]));
        assert!(clear_sight(&world, [2.5, 2.75, 3.5], [5.5, 2.75, 3.5]));

        world.set_block(3, 1, 3, blocks::STONE);
        let start = [2.5, 1.25, 3.5];
        let velocity = [2.0, 0.0, 0.0];
        let mut projectile = arrow(start, velocity);
        let player = [(1, [4.0, 1.0, 3.5])];
        assert!(matches!(
            projectile.tick(&world, player.into_iter()),
            ArrowTick::Keep
        ));
        assert_eq!(projectile.motion.pos, [3.0, 1.25, 3.5]);
        assert_eq!(projectile.motion.velocity, velocity);
        assert_eq!(projectile.embedded_ticks, Some(0));
        for ticks in 1..100 {
            assert!(matches!(
                projectile.tick(&world, player.into_iter()),
                ArrowTick::Keep
            ));
            assert_eq!(projectile.embedded_ticks, Some(ticks));
            assert_eq!(projectile.motion.pos, [3.0, 1.25, 3.5]);
        }
        assert!(matches!(
            projectile.tick(&world, player.into_iter()),
            ArrowTick::Remove
        ));

        let mut projectile = arrow(start, velocity);
        let players = [
            (9, [4.0, 1.0, 3.5]),
            (2, [2.85, 1.0, 3.5]),
            (1, [2.85, 1.0, 3.5]),
        ];
        assert!(matches!(
            projectile.tick(&world, players.into_iter()),
            ArrowTick::Hit(1)
        ));
    }

    #[test]
    fn arrows_expire_at_two_hundred_ticks_or_leave_the_loaded_world() {
        let world = world();
        let mut projectile = arrow([2.5, 10000.0, 3.5], [0.0, 1.2, 0.0]);
        for age in 1..200 {
            assert!(matches!(
                projectile.tick(&world, std::iter::empty()),
                ArrowTick::Keep
            ));
            assert_eq!(projectile.age, age);
        }
        assert!(matches!(
            projectile.tick(&world, std::iter::empty()),
            ArrowTick::Remove
        ));
        for (pos, velocity) in [
            ([15.5, 20.0, 3.5], [1.2, 0.0, 0.0]),
            ([16.5, 20.0, 3.5], [-1.2, 0.0, 0.0]),
            ([2.5, VOID_Y, 3.5], [0.0, -1.0, 0.0]),
        ] {
            assert!(matches!(
                arrow(pos, velocity).tick(&world, std::iter::empty()),
                ArrowTick::Remove
            ));
        }
    }

    #[test]
    fn survival_hits_remove_arrows_and_save_cause_seven_creative_passes_through() {
        for game_mode in [GameMode::Creative, GameMode::Survival] {
            let mut server = Server::new(2026, Generator::Flat);
            server.game_mode = game_mode;
            server.world = world();
            server.connect_at(1, false, Some([3.5, 1.0, 3.5]), None);
            server.handle_packet(
                1,
                &C2S::Hello {
                    protocol: PROTOCOL_VERSION,
                    view_distance: 2,
                }
                .encode(),
            );
            server.tick();
            let arrow_id = server.allocate_entity_id().unwrap();
            let shot = arrow([2.5, 2.0, 3.5], [1.2, 0.0, 0.0]);
            server.arrows.insert(arrow_id, shot.clone());
            server.tick_arrows();
            if game_mode == GameMode::Creative {
                assert_eq!(server.clients[&1].health.vitals.health, 20);
                assert_eq!(server.arrows[&arrow_id].motion.pos, [3.7, 2.0, 3.5]);
                continue;
            }
            assert_eq!(server.clients[&1].health.vitals.health, 17);
            assert!(server.arrows.is_empty());
            server.clients.get_mut(&1).unwrap().health.vitals.health = 3;
            server.arrows.insert(arrow_id, shot);
            server.tick_arrows();
            let vitals = server.clients[&1].health.vitals;
            assert!(vitals.dead);
            assert_eq!(vitals.cause as u8, 7);
            assert!(server.arrows.is_empty());
            let saved = server.inventory_data(1).unwrap();
            assert_eq!(crate::Inventory::from_bytes(&saved).unwrap().1, vitals);
            server.tick_health();
            assert!(server
                .take_outbox()
                .contains(&(1, vitals.packet().encode())));
        }
    }

    #[test]
    fn arrow_hash_covers_motion_age_and_embedding_only_while_present() {
        let mut server = Server::new(2026, Generator::Flat);
        let before = server.state_hash();
        let original = arrow([2.5, 2.0, 3.5], [1.2, 0.0, 0.0]);
        server.arrows.insert(1, original.clone());
        let hash = server.state_hash();
        assert_ne!(hash, before);
        for mutate in [
            |a: &mut Arrow| a.motion.pos[0] += 0.25,
            |a: &mut Arrow| a.motion.velocity[1] = -0.05,
            |a: &mut Arrow| a.age = 1,
            |a: &mut Arrow| a.embedded_ticks = Some(0),
        ] {
            let mut changed = original.clone();
            mutate(&mut changed);
            server.arrows.insert(1, changed);
            assert_ne!(server.state_hash(), hash);
        }
        server.arrows.clear();
        assert_eq!(server.state_hash(), before);
    }
}
