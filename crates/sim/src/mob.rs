//! Transient animals and their deterministic spawning and movement.
use std::collections::BTreeMap;

use jmath::sin_table::{cos, sin};
use physics::{BlockWorld, CollisionWorld, Input, Player};
pub use protocol::MobKind;
use protocol::S2C;
use world::{blocks, Fnv64, World, HEIGHT, MIN_Y};

use crate::{health::VOID_Y, Server};

const COW_WIDTH: f64 = 0.9;
const COW_HEIGHT: f64 = 1.3;
const WALK_FORWARD: f32 = 0.5;
const WALK_CHANCE: u64 = 120;
const WALK_TICKS: u8 = 100;
const STOP_DISTANCE_SQUARED: f64 = 0.5 * 0.5;
const PROBE_DISTANCE: f64 = 0.7;
const SPAWN_INTERVAL: i64 = 400;
const LOCAL_LIMIT: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Wander {
    Idle,
    Walking {
        target: [f64; 2],
        ticks_left: u8,
        blocked: u8,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mob {
    pub kind: MobKind,
    pub yaw: f32,
    pub age: u32,
    body: Player,
    ai: Wander,
}

impl Mob {
    fn cow(pos: [f64; 3]) -> Self {
        Self {
            kind: MobKind::Cow,
            yaw: 0.0,
            age: 0,
            body: Player::with_size(pos, COW_WIDTH, COW_HEIGHT),
            ai: Wander::Idle,
        }
    }

    pub fn pos(&self) -> [f64; 3] {
        self.body.position
    }

    pub(crate) fn chunk(&self) -> (i32, i32) {
        let [x, _, z] = self.pos().map(|v| v.floor() as i32);
        (x >> 4, z >> 4)
    }

    fn stop(&mut self) {
        self.ai = Wander::Idle;
        self.body.velocity[0] = 0.0;
        self.body.velocity[2] = 0.0;
    }

    fn tick(&mut self, world: &World, seed: i64, id: u32, time: i64) {
        self.age = self.age.saturating_add(1);
        let before = self.pos();
        let [x, y, z] = before;
        let collisions = BlockWorld(|x, y, z| {
            if (MIN_Y..MIN_Y + HEIGHT).contains(&y) {
                // The shared physics treats fluids as swimmable. For cows only water is swimmable.
                world.get_block(x, y, z).map(|state| {
                    if blocks::is_lava(state) {
                        blocks::AIR
                    } else {
                        state
                    }
                })
            } else {
                Some(blocks::AIR)
            }
        });
        let mut input = Input {
            jump: physics::in_water(&collisions, before),
            ..Input::default()
        };
        if self.ai == Wander::Idle {
            let random = sample(seed, id, time, 0);
            if random.is_multiple_of(WALK_CHANCE) {
                let [dx, dz] = direction(sample(seed, id, time, 1));
                let range = 1.0 + (sample(seed, id, time, 2) % 700) as f64 / 100.0;
                self.ai = Wander::Walking {
                    target: [x + dx * range, z + dz * range],
                    ticks_left: WALK_TICKS,
                    blocked: 0,
                };
            }
        }

        let idle_input = input;
        let mut step_jump = false;
        if let Wander::Walking { target, .. } = self.ai {
            let dx = target[0] - x;
            let dz = target[1] - z;
            let distance_squared = dx * dx + dz * dz;
            if distance_squared <= STOP_DISTANCE_SQUARED {
                self.stop();
            } else {
                let scale = PROBE_DISTANCE / distance_squared.sqrt();
                let ahead = [x + dx * scale, y, z + dz * scale];
                if let Some(jump) = safe_ahead(world, &collisions, ahead) {
                    self.yaw = heading(dx, dz);
                    input.yaw = self.yaw;
                    input.forward = WALK_FORWARD;
                    step_jump = jump;
                    input.jump |= jump;
                } else {
                    self.stop();
                }
            }
        }

        let was_rising = !self.body.on_ground && self.body.velocity[1] > 0.0;
        let mut next = self.body;
        next.tick(input, &collisions);
        if input.forward != 0.0 && touches_lava(world, next.position) {
            // Horizontal momentum can differ from the intended heading when turning.
            self.stop();
            self.body.tick(idle_input, &collisions);
        } else {
            self.body = next;
        }
        if let Wander::Walking {
            target,
            ticks_left,
            blocked,
        } = self.ai
        {
            // A step jump can take several ticks at the wall.
            // Check horizontal progress every tick while swimming.
            let jumping = !self.body.in_water
                && !self.body.on_ground
                && (step_jump || was_rising || self.body.velocity[1] > 0.0);
            let blocked = if !jumping && distance_squared(before, self.pos()) < 0.01 * 0.01 {
                blocked + 1
            } else {
                0
            };
            if ticks_left == 1
                || blocked == 2
                || distance_squared(self.pos(), [target[0], 0.0, target[1]])
                    <= STOP_DISTANCE_SQUARED
            {
                self.stop();
            } else {
                self.ai = Wander::Walking {
                    target,
                    ticks_left: ticks_left - 1,
                    blocked,
                };
            }
        }
    }

    fn hash_into(&self, h: &mut Fnv64) {
        h.u8(self.kind.wire_id());
        for v in self.pos().into_iter().chain(self.body.velocity) {
            h.bytes(&v.to_bits().to_be_bytes());
        }
        h.bytes(&self.yaw.to_bits().to_be_bytes());
        h.bytes(&self.age.to_be_bytes());
        h.u8(self.body.on_ground as u8);
        h.u8(self.body.in_water as u8);
        h.u8(self.body.jump_cooldown());
        match self.ai {
            Wander::Idle => h.u8(0),
            Wander::Walking {
                target,
                ticks_left,
                blocked,
            } => {
                h.u8(1);
                for v in target {
                    h.bytes(&v.to_bits().to_be_bytes());
                }
                h.u8(ticks_left);
                h.u8(blocked);
            }
        }
    }
}

/// None means stop. A solid block at foot level can ask physics to jump.
fn safe_ahead(world: &World, collisions: &impl CollisionWorld, pos: [f64; 3]) -> Option<bool> {
    let [x, y, z] = pos.map(|v| v.floor() as i32);
    let foot = world.get_block(x, y, z)?;
    let below = world.get_block(x, y - 1, z)?;
    if blocks::is_lava(below) || touches_lava(world, pos) {
        return None;
    }
    if blocks::is_water(foot) || blocks::is_water(below) {
        return Some(false);
    }
    // Probe actual surfaces in the next column, including slabs and fences.
    let top_at = |height| {
        let mut highest: Option<f64> = None;
        collisions.collision_boxes(x, height, z, &mut |bounds| {
            if (bounds.min[0]..bounds.max[0]).contains(&pos[0])
                && (bounds.min[2]..bounds.max[2]).contains(&pos[2])
            {
                highest = Some(highest.map_or(bounds.max[1], |top| top.max(bounds.max[1])));
            }
        });
        highest
    };
    if let Some(foot_top) = top_at(y).filter(|&top| top > pos[1]) {
        let rise = foot_top - pos[1];
        return Some(
            rise > physics::STEP_HEIGHT
                && rise <= 1.0
                && Player::with_size([pos[0], foot_top, pos[2]], COW_WIDTH, COW_HEIGHT)
                    .is_clear(collisions),
        );
    }
    let cutoff = pos[1] - 4.0;
    for floor in (y - 5..=y).rev() {
        let state = world.get_block(x, floor, z)?;
        if blocks::is_lava(state) {
            return None;
        }
        if (blocks::is_water(state) && f64::from(floor + 1) > cutoff)
            || (blocks::is_solid(state) && top_at(floor).is_some_and(|top| top > cutoff))
        {
            return Some(false);
        }
    }
    None
}

fn touches_lava(world: &World, [x, y, z]: [f64; 3]) -> bool {
    let half = COW_WIDTH / 2.0;
    ((x - half).floor() as i32..=(x + half).floor() as i32).any(|x| {
        ((z - half).floor() as i32..=(z + half).floor() as i32).any(|z| {
            (y.floor() as i32..=(y + COW_HEIGHT).floor() as i32)
                .any(|y| world.get_block(x, y, z).is_some_and(blocks::is_lava))
        })
    })
}

fn distance_squared([x, _, z]: [f64; 3], [other_x, _, other_z]: [f64; 3]) -> f64 {
    let dx = x - other_x;
    let dz = z - other_z;
    dx * dx + dz * dz
}

fn direction(random: u64) -> [f64; 2] {
    let radians = (random & 0xffff) as f32 * (std::f32::consts::TAU / 65536.0);
    [f64::from(sin(radians)), f64::from(cos(radians))]
}

/// Approximate atan in the first octant, then reflect to the physics yaw convention.
fn heading(dx: f64, dz: f64) -> f32 {
    let x = dx.abs();
    let z = dz.abs();
    let atan_degrees = |ratio: f64| ratio * (45.0 + 15.64 * (1.0 - ratio));
    let angle = if x > z {
        90.0 - atan_degrees(z / x)
    } else {
        atan_degrees(x / z)
    };
    let angle = if dz < 0.0 { 180.0 - angle } else { angle };
    (if dx > 0.0 { 360.0 - angle } else { angle }) as f32
}

/// SplitMix64 finalizer. Separate salts give independent draws without persistent RNG state.
fn sample(seed: i64, id: u32, time: i64, salt: u64) -> u64 {
    let mut bits = (seed as u64)
        ^ u64::from(id).wrapping_mul(0xd1b5_4a32_d192_ed03)
        ^ (time as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ salt.wrapping_mul(0x94d0_49bb_1331_11eb);
    bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    bits ^ (bits >> 31)
}

fn grass_surface(world: &World, x: i32, z: i32) -> Option<[f64; 3]> {
    let chunk = world.chunks.get(&(x >> 4, z >> 4))?;
    let get = |y| chunk.get((x & 15) as usize, y, (z & 15) as usize);
    let ground = (MIN_Y..MIN_Y + HEIGHT)
        .rev()
        .find(|&y| blocks::is_solid(get(y)))?;
    if get(ground) == blocks::GRASS_BLOCK
        && get(ground + 1) == blocks::AIR
        && get(ground + 2) == blocks::AIR
    {
        Some([
            f64::from(x) + 0.5,
            f64::from(ground + 1),
            f64::from(z) + 0.5,
        ])
    } else {
        None
    }
}

// Distinct columns inside a radius of two blocks, ordered around the center.
const HERD_OFFSETS: [(i32, i32); 12] = [
    (1, 0),
    (2, 0),
    (1, 1),
    (0, 1),
    (0, 2),
    (-1, 1),
    (-1, 0),
    (-2, 0),
    (-1, -1),
    (0, -1),
    (0, -2),
    (1, -1),
];

impl Server {
    pub fn mobs(&self) -> &BTreeMap<u32, Mob> {
        &self.mobs
    }

    fn spawn_cow(&mut self, pos: [f64; 3]) {
        if let Some(id) = self.allocate_entity_id() {
            self.mobs.insert(id, Mob::cow(pos));
        }
    }

    fn spawn_herd(&mut self, id: u32, pos: [f64; 3], players: &[(u32, [f64; 3])]) {
        let nearby = self
            .mobs
            .values()
            .filter(|mob| distance_squared(mob.pos(), pos) <= 64.0 * 64.0)
            .count();
        if nearby >= LOCAL_LIMIT {
            return;
        }
        let [dx, dz] = direction(sample(self.seed, id, self.game_time, 3));
        // Leave room for rounding to the center of a column.
        let radius = 24.75 + (sample(self.seed, id, self.game_time, 4) % 2251) as f64 / 100.0;
        let x = (pos[0] + dx * radius).floor() as i32;
        let z = (pos[2] + dz * radius).floor() as i32;
        let valid_column = |world: &World, x, z| {
            let candidate = [f64::from(x) + 0.5, 0.0, f64::from(z) + 0.5];
            if !(24.0 * 24.0..=48.0 * 48.0).contains(&distance_squared(pos, candidate))
                || players
                    .iter()
                    .any(|&(other, p)| other != id && distance_squared(p, candidate) <= 24.0 * 24.0)
            {
                return None;
            }
            grass_surface(world, x, z)
        };
        let Some(center) = valid_column(&self.world, x, z) else {
            return;
        };
        self.spawn_cow(center);
        let size = (1 + sample(self.seed, id, self.game_time, 5) % 3) as usize;
        let start = (sample(self.seed, id, self.game_time, 6) % HERD_OFFSETS.len() as u64) as usize;
        for offset in 0..size.min(LOCAL_LIMIT - nearby) - 1 {
            let (dx, dz) = HERD_OFFSETS[(start + offset) % HERD_OFFSETS.len()];
            if let Some(candidate) = valid_column(&self.world, x + dx, z + dz) {
                self.spawn_cow(candidate);
            }
        }
    }

    pub(crate) fn tick_mobs(&mut self) {
        let players: Vec<_> = self
            .clients
            .iter()
            .filter(|(_, c)| c.joined)
            .map(|(&id, c)| (id, c.pos))
            .collect();
        if self.game_time % SPAWN_INTERVAL == 0 {
            for &(id, pos) in &players {
                self.spawn_herd(id, pos, &players);
            }
        }
        for (&id, mob) in &mut self.mobs {
            if self.world.chunks.contains_key(&mob.chunk()) && mob.pos()[1] >= VOID_Y {
                mob.tick(&self.world, self.seed, id, self.game_time);
            }
        }
        self.mobs.retain(|_, mob| {
            mob.pos()[1] >= VOID_Y
                && self.world.chunks.contains_key(&mob.chunk())
                && players
                    .iter()
                    .any(|&(_, pos)| distance_squared(mob.pos(), pos) <= 128.0 * 128.0)
        });
    }

    pub(crate) fn sync_mobs(&mut self) {
        for (&client, c) in self.clients.iter_mut().filter(|(_, c)| c.joined) {
            let visible: BTreeMap<_, _> = self
                .mobs
                .iter()
                .filter(|(_, mob)| c.sent.contains(&mob.chunk()))
                .map(|(&id, mob)| (id, (mob.pos(), mob.yaw)))
                .collect();
            for &id in c.visible_mobs.keys().filter(|id| !visible.contains_key(id)) {
                self.outbox
                    .push((client, S2C::EntityRemove { id }.encode()));
            }
            for (&id, &(pos, yaw)) in &visible {
                let [x, y, z] = pos;
                let packet = match c.visible_mobs.get(&id) {
                    None => S2C::MobSpawn {
                        id,
                        kind: self.mobs[&id].kind,
                        x,
                        y,
                        z,
                        yaw,
                    },
                    Some(old) if *old != (pos, yaw) => S2C::MobMove { id, x, y, z, yaw },
                    Some(_) => continue,
                };
                self.outbox.push((client, packet.encode()));
            }
            c.visible_mobs = visible;
        }
    }

    pub(crate) fn hash_mobs(&self, h: &mut Fnv64) {
        if !self.mobs.is_empty() {
            h.i64(self.mobs.len() as i64);
            for (&id, mob) in &self.mobs {
                h.bytes(&id.to_be_bytes());
                mob.hash_into(h);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GameMode;
    use protocol::{C2S, PROTOCOL_VERSION};
    use world::Chunk;
    use worldgen::Generator;

    fn arena(floor_end: i32) -> World {
        let mut world = World::default();
        world.chunks.insert((0, 0), Chunk::empty(0, 0));
        for x in 0..16 {
            for z in 0..floor_end {
                world.set_block(x, 0, z, blocks::STONE);
            }
        }
        world
    }

    fn walking() -> Mob {
        let mut cow = Mob::cow([2.5, 1.0, 2.0]);
        cow.body.on_ground = true;
        cow.ai = Wander::Walking {
            target: [2.5, 9.0],
            ticks_left: 100,
            blocked: 0,
        };
        cow
    }

    #[test]
    fn idle_walk_and_stop_are_deterministic() {
        let world = arena(16);
        let mut a = Mob::cow([8.5, 1.0, 8.5]);
        let mut b = a.clone();
        let start = (1..1000)
            .find(|&t| sample(5, 7, t, 0).is_multiple_of(WALK_CHANCE))
            .unwrap();
        a.tick(&world, 5, 7, start - 1);
        b.tick(&world, 5, 7, start - 1);
        assert_eq!(a.ai, Wander::Idle);
        a.tick(&world, 5, 7, start);
        b.tick(&world, 5, 7, start);
        assert!(matches!(a.ai, Wander::Walking { .. }));
        let mut stopped = false;
        for t in start + 1..=start + 100 {
            a.tick(&world, 5, 7, t);
            b.tick(&world, 5, 7, t);
            assert_eq!(a, b);
            if a.ai == Wander::Idle {
                stopped = true;
                break;
            }
        }
        assert!(stopped);
        assert!(distance_squared(a.pos(), [8.5, 1.0, 8.5]) > 0.25);
    }

    #[test]
    fn target_timeout_and_two_blocked_ticks_stop_walks() {
        let mut world = arena(16);
        let mut cow = walking();
        cow.ai = Wander::Walking {
            target: [2.5, 2.5],
            ticks_left: 100,
            blocked: 0,
        };
        cow.tick(&world, 5, 7, 1);
        assert_eq!(cow.ai, Wander::Idle);
        cow.ai = Wander::Walking {
            target: [2.5, 9.0],
            ticks_left: 1,
            blocked: 0,
        };
        cow.tick(&world, 5, 7, 2);
        assert!(cow.pos()[2] > 2.0);
        assert_eq!(cow.ai, Wander::Idle);

        world.set_block(2, 1, 3, blocks::STONE);
        world.set_block(2, 2, 3, blocks::STONE);
        let mut cow = walking();
        cow.body.position[2] = 3.0 - COW_WIDTH / 2.0;
        cow.tick(&world, 5, 7, 1);
        assert!(matches!(cow.ai, Wander::Walking { blocked: 1, .. }));
        cow.tick(&world, 5, 7, 2);
        assert_eq!(cow.ai, Wander::Idle);
    }

    #[test]
    fn cliffs_and_lava_stop_walks_before_contact() {
        let mut cliff = arena(3);
        for z in 3..16 {
            cliff.set_block(2, -4, z, blocks::STONE);
        }
        let mut foot_lava = arena(16);
        foot_lava.set_block(2, 1, 3, blocks::LAVA);
        let mut body_lava = arena(16);
        body_lava.set_block(2, 2, 3, blocks::FALLING_LAVA);
        let mut floor_lava = arena(16);
        floor_lava.set_block(2, 0, 3, blocks::LAVA);
        for world in [cliff, foot_lava, body_lava, floor_lava] {
            let mut cow = walking();
            for t in 1..20 {
                cow.tick(&world, 5, 7, t);
                if cow.ai == Wander::Idle {
                    break;
                }
            }
            assert_eq!(cow.ai, Wander::Idle);
            assert!(cow.pos()[2] < 3.0 - COW_WIDTH / 2.0);
            assert_eq!(cow.pos()[1], 1.0);
        }
    }

    #[test]
    fn jumps_from_contact_with_a_full_block_step() {
        let mut world = arena(16);
        for z in 3..16 {
            world.set_block(2, 1, z, blocks::STONE);
        }
        let mut cow = walking();
        cow.body.position[2] = 2.55;
        for tick in 1..=2 {
            cow.tick(&world, 5, 7, tick);
            assert_eq!(cow.pos()[2], 2.55);
            assert!(matches!(cow.ai, Wander::Walking { blocked: 0, .. }));
        }
        for tick in 3..=30 {
            cow.tick(&world, 5, 7, tick);
        }
        assert_eq!(cow.pos()[1], 2.0);
        assert!(cow.pos()[2] > 3.45, "{cow:?}");
    }

    #[test]
    fn underwater_wall_and_ceiling_stops_a_walk_within_two_ticks() {
        let mut world = arena(16);
        world.set_block(2, 1, 2, blocks::WATER);
        world.set_block(2, 2, 2, blocks::WATER);
        world.set_block(2, 3, 2, blocks::STONE);
        for y in 1..=3 {
            world.set_block(2, y, 3, blocks::STONE);
        }
        let mut cow = walking();
        cow.body.on_ground = false;
        cow.body.position[1] = 1.6;
        cow.body.position[2] = 3.0 - COW_WIDTH / 2.0;

        cow.tick(&world, 5, 7, 1);
        assert!(
            matches!(cow.ai, Wander::Walking { blocked: 1, .. }),
            "{cow:?}"
        );
        cow.tick(&world, 5, 7, 2);
        assert_eq!(cow.ai, Wander::Idle);
        assert!(cow.pos()[2] < 3.0);
    }

    #[test]
    fn walks_across_unsupported_bottom_slabs_at_foot_height() {
        let mut world = arena(0);
        for z in 1..=8 {
            world.set_block(2, 0, z, blocks::OAK_SLAB);
        }
        let mut cow = walking();
        cow.body.position[1] = 0.5;
        for tick in 1..=30 {
            cow.tick(&world, 5, 7, tick);
            assert_eq!(cow.pos()[1], 0.5);
        }
        assert!(cow.pos()[2] > 4.0, "{cow:?}");
    }

    #[test]
    fn jump_checks_the_collision_shape_above_the_step() {
        for (ceiling, can_jump) in [(blocks::OAK_SLAB + 1, true), (blocks::STONE, false)] {
            let mut world = arena(16);
            for z in 3..16 {
                world.set_block(2, 1, z, blocks::STONE);
                world.set_block(2, 3, z, ceiling);
            }
            let mut cow = walking();
            cow.body.position[2] = 2.55;
            cow.tick(&world, 5, 7, 1);
            assert_eq!(cow.pos()[1] > 1.0, can_jump, "{cow:?}");
            for tick in 2..=30 {
                cow.tick(&world, 5, 7, tick);
            }
            if can_jump {
                assert_eq!(cow.pos()[1], 2.0);
                assert!(cow.pos()[2] > 3.45, "{cow:?}");
            } else {
                assert_eq!(cow.pos(), [2.5, 1.0, 2.55]);
                assert_eq!(cow.ai, Wander::Idle);
            }
        }
    }

    #[test]
    fn jumps_onto_a_full_block_step_and_floats_in_water() {
        let mut world = arena(16);
        for z in 3..16 {
            world.set_block(2, 1, z, blocks::STONE);
        }
        let mut cow = walking();
        let mut jumped = false;
        for t in 1..35 {
            cow.tick(&world, 5, 7, t);
            jumped |= cow.pos()[1] > 2.0;
        }
        assert!(jumped);
        assert!(cow.pos()[2] > 3.0, "{cow:?}");
        assert_eq!(cow.pos()[1], 2.0);

        let mut pool = arena(16);
        for y in 1..=3 {
            pool.set_block(2, y, 2, blocks::WATER);
        }
        let mut cow = Mob::cow([2.5, 1.0, 2.5]);
        let quiet = (1..1000)
            .find(|&t| !sample(5, 7, t, 0).is_multiple_of(WALK_CHANCE))
            .unwrap();
        for _ in 0..80 {
            cow.tick(&pool, 5, 7, quiet);
        }
        let mut low = cow.pos()[1];
        let mut high = low;
        for _ in 0..60 {
            cow.tick(&pool, 5, 7, quiet);
            low = low.min(cow.pos()[1]);
            high = high.max(cow.pos()[1]);
        }
        assert!(low > 3.0 && low < 3.6, "{low}");
        assert!(high > 3.6 && high < 4.0, "{high}");
    }

    fn joined(mode: GameMode) -> Server {
        let mut server = Server::new(2026, Generator::Flat);
        server.game_mode = mode;
        server.connect(1);
        server.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 4,
            }
            .encode(),
        );
        // Service the chunk requests just as the host does.
        for _ in 0..45 {
            server.tick();
            for (cx, cz) in server.take_requests() {
                server.chunk_missing(cx, cz);
            }
            server.take_outbox();
        }
        server
    }

    #[test]
    fn herds_spawn_on_the_400th_tick_in_both_modes_and_repeat() {
        let expected = [[45.5, -60.0, 2.5], [46.5, -60.0, 1.5], [46.5, -60.0, 2.5]];
        let mut trajectories = Vec::new();
        for mode in [GameMode::Creative, GameMode::Survival] {
            let mut server = joined(mode);
            server.set_time(398, 6000);
            server.tick();
            assert!(server.mobs().is_empty());
            server.tick();
            let cows: Vec<_> = server.mobs().values().map(Mob::pos).collect();
            assert!((1..=3).contains(&cows.len()));
            for &[x, y, z] in &cows {
                let distance = distance_squared(server.spawn(), [x, y, z]);
                assert!((24.0 * 24.0..=48.0 * 48.0).contains(&distance));
                assert!(distance_squared(cows[0], [x, y, z]) <= 4.0);
                assert_eq!(
                    server.get_block(x.floor() as i32, y.floor() as i32 - 1, z.floor() as i32),
                    Some(blocks::GRASS_BLOCK)
                );
            }
            assert_eq!(cows, expected);
            while server.game_time() < 600 {
                server.tick();
            }
            assert_eq!(server.mobs.len(), 3);
            let end: Vec<_> = server.mobs.values().map(Mob::pos).collect();
            assert_ne!(end, expected);
            trajectories.push(end);
        }
        assert_eq!(trajectories[0], trajectories[1]);
    }

    #[test]
    fn herd_center_requires_loaded_grass_air_and_distance_from_others() {
        let mut server = joined(GameMode::Creative);
        let pos = server.spawn();
        server.game_time = 400;
        let players = [(1, pos)];
        server.spawn_herd(1, pos, &players);
        let center = server.mobs().first_key_value().unwrap().1.pos();
        let [x, y, z] = center.map(|v| v.floor() as i32);
        server.mobs.clear();
        // A player standing at the candidate blocks the first player's herd.
        server.spawn_herd(1, pos, &[(1, pos), (2, center)]);
        assert!(server.mobs().is_empty());
        for (height, state) in [
            (y - 1, blocks::DIRT),
            (y, blocks::WATER),
            (y + 1, blocks::STONE),
            (y + 5, blocks::STONE),
        ] {
            let old = server.world.set_block(x, height, z, state).unwrap();
            server.spawn_herd(1, pos, &players);
            assert!(server.mobs().is_empty());
            server.world.set_block(x, height, z, old);
        }
        for _ in 0..7 {
            server.spawn_cow(pos);
        }
        server.spawn_herd(1, pos, &players);
        assert_eq!(server.mobs().len(), 8);
        server.spawn_herd(1, pos, &players);
        assert_eq!(server.mobs().len(), 8);
        server.mobs.clear();
        server.world.remove_chunk(x >> 4, z >> 4);
        server.spawn_herd(1, pos, &players);
        assert!(server.mobs().is_empty());
    }

    #[test]
    fn despawns_beyond_128_in_missing_chunks_and_below_void() {
        let mut server = joined(GameMode::Creative);
        let [x, y, z] = server.spawn();
        for dx in [128.0, 129.0] {
            let cx = ((x + dx).floor() as i32) >> 4;
            server
                .world
                .chunks
                .insert((cx, 0), worldgen::generate(Generator::Flat, 2026, cx, 0));
            server.spawn_cow([x + dx, y, z]);
        }
        server.spawn_cow([x, VOID_Y - 1.0, z]);
        server.spawn_cow([x, y, z]);
        server.tick_mobs();
        assert_eq!(server.mobs.keys().copied().collect::<Vec<_>>(), [1, 4]);
        server.unload_far_chunks();
        assert_eq!(server.mobs.keys().copied().collect::<Vec<_>>(), [4]);
        server.world.remove_chunk(0, 0);
        server.tick_mobs();
        assert!(server.mobs().is_empty());
    }

    #[test]
    fn visibility_deltas_use_shared_ids_and_state_hash_uses_mob_state() {
        let mut server = joined(GameMode::Creative);
        server.connect(2);
        server.clients.get_mut(&2).unwrap().joined = true;
        let pos = server.spawn();
        server.spawn_item(1, 1, pos, [0.0; 3], 20);
        let empty_hash = server.state_hash();
        server.spawn_cow(pos);
        let id = 2;
        assert!(server.entities.contains_key(&1));
        let with_cow = server.state_hash();
        assert_ne!(with_cow, empty_hash);
        // Keep the ID allocator fixed while checking the mob's contribution.
        let cow = server.mobs.remove(&id).unwrap();
        assert_ne!(server.state_hash(), with_cow);
        server.mobs.insert(id, cow);
        server.sync_mobs();
        let packets = |server: &mut Server| {
            server
                .take_outbox()
                .into_iter()
                .map(|(client, bytes)| (client, S2C::decode(&bytes).unwrap()))
                .collect::<Vec<_>>()
        };
        assert!(matches!(
            packets(&mut server).as_slice(),
            [(1, S2C::MobSpawn { id: 2, .. })]
        ));
        server.sync_mobs();
        assert!(packets(&mut server).is_empty());

        let hash = server.state_hash();
        server.mobs.get_mut(&id).unwrap().yaw = 90.0;
        assert_ne!(server.state_hash(), hash);
        server.sync_mobs();
        assert!(matches!(
            packets(&mut server).as_slice(),
            [(
                1,
                S2C::MobMove {
                    id: 2,
                    yaw: 90.0,
                    ..
                }
            )]
        ));
        let hash = server.state_hash();
        server.mobs.get_mut(&id).unwrap().body.position[0] += 0.125;
        assert_ne!(server.state_hash(), hash);
        server.sync_mobs();
        assert!(matches!(
            packets(&mut server).as_slice(),
            [(1, S2C::MobMove { id: 2, .. })]
        ));

        let hash = server.state_hash();
        server.mobs.get_mut(&id).unwrap().body.velocity[0] = 0.25;
        assert_ne!(server.state_hash(), hash);
        let hash = server.state_hash();
        server.mobs.get_mut(&id).unwrap().ai = walking().ai;
        assert_ne!(server.state_hash(), hash);
        server.sync_mobs();
        assert!(packets(&mut server).is_empty());

        server.clients.get_mut(&1).unwrap().sent.clear();
        server.sync_mobs();
        assert_eq!(packets(&mut server), [(1, S2C::EntityRemove { id })]);
        let chunk = server.mobs[&id].chunk();
        server.clients.get_mut(&2).unwrap().sent.insert(chunk);
        server.sync_mobs();
        assert!(matches!(
            packets(&mut server).as_slice(),
            [(2, S2C::MobSpawn { id: 2, .. })]
        ));
        server.mobs.remove(&id);
        server.sync_mobs();
        assert_eq!(packets(&mut server), [(2, S2C::EntityRemove { id })]);
    }
}
