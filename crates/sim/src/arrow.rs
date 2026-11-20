//! Transient projectiles with swept collision and recovery from blocks.
use std::collections::BTreeMap;

use jmath::sin_table::{cos, sin};
use physics::{Aabb, BlockWorld, CollisionWorld, Player};
use protocol::{DeathCause, S2C};
use world::{items, Fnv64, World};

use crate::{health::VOID_Y, Client, GameMode, Server};

const FLIGHT_LIFETIME: u8 = 200;
const EMBEDDED_LIFETIME: u8 = 100;
const SKELETON_DAMAGE: u8 = 3;
const PICKUP_DELAY: u8 = 10;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Shooter {
    Skeleton,
    Player { id: u32, recoverable: bool },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ArrowMotion {
    pub pos: [f64; 3],
    pub velocity: [f64; 3],
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Arrow {
    motion: ArrowMotion,
    shooter: Shooter,
    power: f64,
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
            shooter: Shooter::Skeleton,
            power: 0.0,
            age: 0,
            embedded_ticks: None,
        }
    }

    pub(crate) fn from_bow(
        id: u32,
        recoverable: bool,
        power: f64,
        mut feet: [f64; 3],
        yaw: f32,
        pitch: f32,
    ) -> Self {
        let yaw = f64::from(yaw);
        let degrees = (yaw - (yaw / 360.0).floor() * 360.0).clamp(0.0, 360.0);
        let radians = std::f32::consts::PI / 180.0;
        let yaw = degrees as f32 * radians;
        let direction = if pitch == 90.0 || pitch == -90.0 {
            [0.0, -f64::from(pitch) / 90.0, 0.0]
        } else {
            let pitch = pitch * radians;
            let cp = f64::from(cos(pitch));
            let [x, y, z] = [
                -f64::from(sin(yaw)) * cp,
                -f64::from(sin(pitch)),
                f64::from(cos(yaw)) * cp,
            ];
            let length = (x * x + y * y + z * z).sqrt();
            [x / length, y / length, z / length]
        };
        feet[1] += physics::EYE_HEIGHT;
        let pos = std::array::from_fn(|axis| feet[axis] + 0.3 * direction[axis]);
        let speed = 0.6 + 2.4 * power;
        let velocity = direction.map(|v| v * speed);
        Self {
            motion: ArrowMotion { pos, velocity },
            shooter: Shooter::Player { id, recoverable },
            power,
            age: 0,
            embedded_ticks: None,
        }
    }

    pub(crate) fn chunk(&self) -> (i32, i32) {
        let [x, _, z] = self.motion.pos.map(|v| v.floor() as i32);
        (x >> 4, z >> 4)
    }

    fn ready_for_pickup(&self) -> bool {
        matches!(
            self.shooter,
            Shooter::Player {
                recoverable: true,
                ..
            }
        ) && self
            .embedded_ticks
            .is_some_and(|ticks| ticks >= PICKUP_DELAY)
    }

    fn try_pickup(&self, client: &mut Client) -> bool {
        if !client.joined || client.health.vitals.dead {
            return false;
        }
        let bounds = Player::new(client.pos).bounds();
        let [dx, dy, dz] = std::array::from_fn(|axis| {
            let point = self.motion.pos[axis];
            point - point.clamp(bounds.min[axis], bounds.max[axis])
        });
        let item = items::by_name("arrow").unwrap();
        if dy.abs() > 1.0 || dx * dx + dz * dz > 1.0 || client.inventory.add(item, 1) != 0 {
            return false;
        }
        client.inventory_dirty = true;
        true
    }

    fn tick(&mut self, world: &World, targets: impl Iterator<Item = (u32, Aabb)>) -> ArrowTick {
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
        // The block wins a tie. Targets at the same distance are ordered by ID.
        let target = targets
            .filter_map(|(id, bounds)| {
                let time = segment_entry(pos, delta, bounds)?;
                (time <= void_exit && obstacle.as_ref().is_none_or(|hit| time < hit.time))
                    .then_some((time, id))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        if let Some((_, id)) = target {
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
        enum Hit {
            PlayerDeath(u32),
            Mob(u32),
        }
        let mut hits = Vec::new();
        let survival = self.game_mode == GameMode::Survival;
        self.arrows.retain(|_, arrow| {
            let result = match arrow.shooter {
                Shooter::Skeleton => {
                    let players = self
                        .clients
                        .iter()
                        .filter(|(_, client)| {
                            survival && client.joined && !client.health.vitals.dead
                        })
                        .map(|(&id, client)| (id, Player::new(client.pos).bounds()));
                    arrow.tick(&self.world, players)
                }
                Shooter::Player { .. } => {
                    let mobs = self
                        .mobs
                        .iter()
                        .filter(|(_, mob)| mob.health != 0)
                        .map(|(&id, mob)| (id, mob.bounds()));
                    arrow.tick(&self.world, mobs)
                }
            };
            match result {
                ArrowTick::Keep => {
                    !(survival
                        && arrow.ready_for_pickup()
                        && self
                            .clients
                            .values_mut()
                            .any(|client| arrow.try_pickup(client)))
                }
                ArrowTick::Remove => false,
                ArrowTick::Hit(id) => {
                    match arrow.shooter {
                        Shooter::Skeleton => {
                            let health = &mut self.clients.get_mut(&id).unwrap().health;
                            health.damage(SKELETON_DAMAGE, DeathCause::Arrow);
                            if health.vitals.dead {
                                hits.push(Hit::PlayerDeath(id));
                            }
                        }
                        Shooter::Player { .. } => {
                            let mob = self.mobs.get_mut(&id).unwrap();
                            let before = mob.health;
                            let damage = 1 + (arrow.power * 8.0).floor() as u8;
                            let [vx, _, vz] = arrow.motion.velocity;
                            mob.hurt_with_knockback(
                                &self.world,
                                damage,
                                ([vx, vz], true),
                                self.seed,
                                id,
                                self.game_time,
                            );
                            if mob.health != before {
                                hits.push(Hit::Mob(id));
                            }
                        }
                    }
                    false
                }
            }
        });
        for hit in hits {
            match hit {
                Hit::PlayerDeath(id) => self.finish_player_death(id),
                Hit::Mob(id) => self.finish_mob_hit(id),
            }
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
                match arrow.shooter {
                    Shooter::Skeleton => h.u8(0),
                    Shooter::Player { id, recoverable } => {
                        h.u8(1);
                        h.bytes(&id.to_be_bytes());
                        h.u8(u8::from(recoverable));
                    }
                }
                h.bytes(&arrow.power.to_bits().to_be_bytes());
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
    use crate::{mob::Mob, Stack};
    use protocol::{MobKind, C2S, PROTOCOL_VERSION};
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
            shooter: Shooter::Skeleton,
            power: 0.0,
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
            projectile.tick(
                &world,
                player
                    .into_iter()
                    .map(|(id, p)| (id, Player::new(p).bounds()))
            ),
            ArrowTick::Keep
        ));
        assert_eq!(projectile.motion.pos, [3.0, 1.25, 3.5]);
        assert_eq!(projectile.motion.velocity, velocity);
        assert_eq!(projectile.embedded_ticks, Some(0));
        for ticks in 1..100 {
            assert!(matches!(
                projectile.tick(
                    &world,
                    player
                        .into_iter()
                        .map(|(id, p)| (id, Player::new(p).bounds()))
                ),
                ArrowTick::Keep
            ));
            assert_eq!(projectile.embedded_ticks, Some(ticks));
            assert_eq!(projectile.motion.pos, [3.0, 1.25, 3.5]);
        }
        assert!(matches!(
            projectile.tick(
                &world,
                player
                    .into_iter()
                    .map(|(id, p)| (id, Player::new(p).bounds()))
            ),
            ArrowTick::Remove
        ));

        let mut projectile = arrow(start, velocity);
        let players = [
            (9, [4.0, 1.0, 3.5]),
            (2, [2.85, 1.0, 3.5]),
            (1, [2.85, 1.0, 3.5]),
        ];
        assert!(matches!(
            projectile.tick(
                &world,
                players
                    .into_iter()
                    .map(|(id, p)| (id, Player::new(p).bounds()))
            ),
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

    fn with_players(mode: GameMode, players: &[(u32, [f64; 3])]) -> Server {
        let mut server = Server::new(2026, Generator::Flat);
        server.game_mode = mode;
        server.world = world();
        for &(id, pos) in players {
            server.connect_at(id, true, Some(pos), None);
            server.apply(
                id,
                C2S::Hello {
                    protocol: PROTOCOL_VERSION,
                    view_distance: 2,
                },
            );
        }
        server
    }

    #[test]
    fn bow_launch_uses_last_accepted_view_and_draw_power() {
        let feet = [5.0, 2.0, 5.0];
        let mut server = with_players(GameMode::Creative, &[(1, feet)]);
        server.apply(
            1,
            C2S::CreativeSetSlot {
                slot: 0,
                item: items::by_name("bow").unwrap(),
                count: 1,
            },
        );
        server.apply(1, C2S::UseItem);
        for _ in 0..3 {
            server.tick_health();
        }
        let position = |x, yaw, pitch| C2S::PlayerPos {
            x,
            y: feet[1],
            z: feet[2],
            yaw,
            pitch,
        };
        server.apply(1, position(feet[0], 450.0, 30.0));
        server.apply(1, position(feet[0], f32::NAN, f32::INFINITY));
        server.apply(1, position(500.0, 180.0, -80.0));
        server.apply(1, C2S::StopUsingItem);
        let shot = server.arrows.values().next().unwrap();
        assert_eq!(shot.power, 0.15);
        assert_eq!(
            shot.shooter,
            Shooter::Player {
                id: 1,
                recoverable: false
            }
        );
        let [vx, vy, vz] = shot.motion.velocity;
        assert!((vx * vx + vy * vy + vz * vz - 0.96 * 0.96).abs() < 1e-12);
        assert!((vx + 0.96 * 0.75_f64.sqrt()).abs() < 0.0001);
        assert!((vy + 0.48).abs() < 0.0001);
        assert!(vz.abs() < 1e-12);
        let eye = [feet[0], feet[1] + physics::EYE_HEIGHT, feet[2]];
        for (axis, origin) in eye.into_iter().enumerate() {
            assert!(
                (shot.motion.pos[axis] - origin - shot.motion.velocity[axis] * 0.3 / 0.96).abs()
                    < 1e-12
            );
        }
    }

    #[test]
    fn player_arrows_sweep_mobs_ignore_players_and_use_damage_immunity_and_loot() {
        let mut server = with_players(
            GameMode::Survival,
            &[(1, [2.7, 1.0, 3.5]), (2, [3.3, 1.0, 3.5])],
        );
        let id = server.allocate_entity_id().unwrap();
        server
            .mobs
            .insert(id, Mob::new(MobKind::Cow, [4.3, 1.0, 3.5]));
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .visible_mobs
            .insert(id, ([4.3, 1.0, 3.5], 0.0));
        let shot = Arrow::from_bow(1, true, 0.5, [2.0, 0.0, 3.5], 270.0, 0.0);
        for expected_health in [5, 5, 0] {
            if expected_health == 0 {
                server.mobs.get_mut(&id).unwrap().hurt_ticks = 0;
            }
            let arrow_id = server.allocate_entity_id().unwrap();
            server.arrows.insert(arrow_id, shot.clone());
            server.tick_arrows();
            assert!(!server.arrows.contains_key(&arrow_id));
            let outbox = server.take_outbox();
            if expected_health > 0 {
                assert_eq!(server.mobs[&id].health, expected_health);
                assert_eq!(server.mobs[&id].hurt_ticks, 10);
                assert_eq!(
                    outbox.contains(&(1, S2C::MobHurt { id }.encode())),
                    arrow_id == id + 1,
                );
            } else {
                assert!(!server.mobs.contains_key(&id));
                assert!(server
                    .entities
                    .values()
                    .any(|e| Some(e.item) == items::by_name("raw_beef")));
            }
        }
        assert_eq!(server.clients[&1].health.vitals.health, 20);
        assert_eq!(server.clients[&2].health.vitals.health, 20);
    }

    #[test]
    fn wall_blocks_player_arrows_before_a_mob_and_skeleton_arrows_ignore_mobs() {
        let mut server = with_players(GameMode::Survival, &[]);
        let id = server.allocate_entity_id().unwrap();
        server
            .mobs
            .insert(id, Mob::new(MobKind::Cow, [4.3, 1.0, 3.5]));
        let arrow_id = server.allocate_entity_id().unwrap();
        server.world.set_block(3, 1, 3, blocks::STONE);
        let shot = Arrow::from_bow(1, true, 1.0, [2.0, 0.0, 3.5], 270.0, 0.0);
        server.arrows.insert(arrow_id, shot);
        server.tick_arrows();
        assert_eq!(server.mobs[&id].health, 10);
        assert_eq!(server.arrows[&arrow_id].embedded_ticks, Some(0));
        assert_eq!(server.arrows[&arrow_id].motion.pos[0], 3.0);

        server.world.set_block(3, 1, 3, blocks::AIR);
        server
            .arrows
            .insert(arrow_id, arrow([3.6, 1.62, 3.5], [1.2, 0.0, 0.0]));
        server.tick_arrows();
        assert_eq!(server.mobs[&id].health, 10);
        assert_eq!(server.arrows[&arrow_id].motion.pos[0], 4.8);
    }

    #[test]
    fn arrow_pickup_waits_ten_ticks_requires_space_and_uses_contact_distance_and_id_order() {
        // Impact (3.0, 1.62, 3.5) is beyond one block from the feet in both axes
        // for player 2, but within one block of their body.
        let mut server = with_players(
            GameMode::Survival,
            &[
                (3, [4.2, 0.0, 3.5]),
                (2, [1.8, 0.0, 3.5]),
                (1, [4.4, 0.0, 3.5]),
                (4, [1.8, -1.2, 3.5]),
            ],
        );
        server.world.set_block(3, 1, 3, blocks::STONE);
        let item = items::by_name("arrow").unwrap();
        let stone = items::by_name("stone").unwrap();
        for id in [2, 3] {
            let inventory = &mut server.clients.get_mut(&id).unwrap().inventory;
            for slot in 0..crate::inventory::SLOT_COUNT {
                inventory
                    .set(
                        slot as u8,
                        Some(Stack {
                            item: stone,
                            count: 64,
                        }),
                    )
                    .unwrap();
            }
        }
        let arrow_id = server.allocate_entity_id().unwrap();
        server.arrows.insert(
            arrow_id,
            Arrow::from_bow(99, true, 0.5, [2.0, 0.0, 3.5], 270.0, 0.0),
        );
        server.tick_arrows();
        for _ in 0..9 {
            server.tick_arrows();
        }
        for id in [2, 3] {
            server
                .clients
                .get_mut(&id)
                .unwrap()
                .inventory
                .set(35, None)
                .unwrap();
        }
        assert_eq!(server.arrows[&arrow_id].embedded_ticks, Some(9));
        assert!(!server.clients[&2].inventory_dirty);
        server.tick_arrows();
        assert!(server.arrows.is_empty());
        assert_eq!(
            server.clients[&2].inventory.slots()[35],
            Some(Stack { item, count: 1 })
        );
        assert!(server.clients[&2].inventory_dirty);
        assert_eq!(server.clients[&3].inventory.slots()[35], None);
        for id in [1, 4] {
            assert_eq!(server.clients[&id].inventory.first_slot_with(item), None);
        }

        server
            .clients
            .get_mut(&3)
            .unwrap()
            .inventory
            .set(
                35,
                Some(Stack {
                    item: stone,
                    count: 64,
                }),
            )
            .unwrap();
        server
            .clients
            .get_mut(&2)
            .unwrap()
            .inventory
            .set(
                35,
                Some(Stack {
                    item: stone,
                    count: 64,
                }),
            )
            .unwrap();
        let mut shot = Arrow::from_bow(99, true, 0.5, [2.0, 0.0, 3.5], 270.0, 0.0);
        shot.motion.pos = [3.0, 1.62, 3.5];
        shot.embedded_ticks = Some(9);
        server.arrows.insert(arrow_id, shot);
        server.tick_arrows();
        assert_eq!(server.arrows[&arrow_id].embedded_ticks, Some(10));
    }

    #[test]
    fn only_survival_shots_can_be_recovered_and_other_arrows_expire() {
        let mut server = with_players(GameMode::Survival, &[(1, [2.0, 1.0, 3.5])]);
        let mut skeleton = arrow([2.0, 1.62, 3.5], [1.2, 0.0, 0.0]);
        skeleton.embedded_ticks = Some(0);
        let mut creative = Arrow::from_bow(1, false, 1.0, [2.0, 0.0, 3.5], 270.0, 0.0);
        creative.embedded_ticks = Some(0);
        let mut survival = creative.clone();
        survival.shooter = Shooter::Player {
            id: 1,
            recoverable: true,
        };
        server
            .arrows
            .extend([(1, skeleton), (2, creative), (3, survival)]);
        server.set_game_mode(GameMode::Creative);
        for _ in 0..10 {
            server.tick_arrows();
        }
        assert_eq!(server.arrows.len(), 3);
        server.set_game_mode(GameMode::Survival);
        server.tick_arrows();
        assert_eq!(server.arrows.len(), 2);
        let item = items::by_name("arrow").unwrap();
        assert_eq!(
            server.clients[&1].inventory.slots()[0],
            Some(Stack { item, count: 1 })
        );
        for _ in 11..99 {
            server.tick_arrows();
        }
        assert_eq!(server.arrows.len(), 2);
        server.tick_arrows();
        assert!(server.arrows.is_empty());
        assert_eq!(
            server.clients[&1].inventory.slots()[0],
            Some(Stack { item, count: 1 })
        );
    }

    #[test]
    fn bow_draw_flight_and_recovery_replay_deterministically() {
        let setup = || {
            let mut server = with_players(GameMode::Survival, &[(1, [2.5, 1.0, 3.5])]);
            server.world.set_block(2, 0, 3, blocks::STONE);
            server.world.set_block(3, 2, 3, blocks::STONE);
            let inv = &mut server.clients.get_mut(&1).unwrap().inventory;
            for (slot, name) in [(0, "bow"), (1, "arrow")] {
                inv.set(
                    slot,
                    Some(Stack {
                        item: items::by_name(name).unwrap(),
                        count: 1,
                    }),
                )
                .unwrap();
            }
            server
        };
        let (mut a, mut b) = (setup(), setup());
        let hash = a.state_hash();
        a.apply(1, C2S::UseItem);
        b.apply(1, C2S::UseItem);
        assert_ne!(a.state_hash(), hash);
        for tick in 0..20 {
            for s in [&mut a, &mut b] {
                if tick == 5 {
                    s.apply(
                        1,
                        C2S::PlayerPos {
                            x: 2.5,
                            y: 1.0,
                            z: 3.5,
                            yaw: 270.0,
                            pitch: 0.0,
                        },
                    );
                    s.apply(1, C2S::StopUsingItem);
                }
                s.tick();
            }
            assert_eq!(a.state_hash(), b.state_hash(), "tick {tick}");
            assert_eq!(a.take_outbox(), b.take_outbox(), "tick {tick}");
            assert_eq!(a.arrows.len(), usize::from((5..15).contains(&tick)));
        }
        let inv = &a.clients[&1].inventory;
        assert_eq!(
            inv.first_slot_with(items::by_name("arrow").unwrap()),
            Some(1)
        );
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
            |a: &mut Arrow| {
                a.shooter = Shooter::Player {
                    id: 1,
                    recoverable: true,
                }
            },
            |a: &mut Arrow| a.power = 0.5,
        ] {
            let mut changed = original.clone();
            mutate(&mut changed);
            server.arrows.insert(1, changed);
            assert_ne!(server.state_hash(), hash);
        }
        let player_shot = Arrow::from_bow(1, true, 0.5, [2.0, 0.0, 3.5], 0.0, 0.0);
        server.arrows.insert(1, player_shot.clone());
        let player_hash = server.state_hash();
        for shooter in [
            Shooter::Player {
                id: 2,
                recoverable: true,
            },
            Shooter::Player {
                id: 1,
                recoverable: false,
            },
        ] {
            let mut changed = player_shot.clone();
            changed.shooter = shooter;
            server.arrows.insert(1, changed);
            assert_ne!(server.state_hash(), player_hash);
        }
        server.arrows.clear();
        assert_eq!(server.state_hash(), before);
    }
}
