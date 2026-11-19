//! Transient animals and their deterministic spawning and movement.
use std::collections::BTreeMap;
use std::ops::RangeInclusive;

use jmath::sin_table::{cos, sin};
use physics::{BlockWorld, CollisionWorld, Input, Player};
pub use protocol::MobKind;
use protocol::{DeathCause, S2C};
use world::{blocks, items, smelting, Fnv64, World, HEIGHT, MIN_Y};

use crate::{
    health::{
        block_at, hash_height, interval, track_fall, LAVA_DAMAGE, LAVA_FEET_OFFSET, LAVA_INTERVAL,
        SUFFOCATION_DAMAGE, SUFFOCATION_INTERVAL, VOID_Y,
    },
    Server, MAX_REACH,
};

struct MobSpec {
    width: f64,
    height: f64,
    head_offset: f64,
    health: u8,
    walk_forward: f32,
    flee_forward: f32,
    max_fall_speed: Option<f64>,
    takes_fall_damage: bool,
    loot: &'static [(u16, u8, u8)],
}

const fn spec(kind: MobKind) -> &'static MobSpec {
    match kind {
        MobKind::Cow => &MobSpec {
            width: 0.9,
            height: 1.3,
            head_offset: 1.1,
            health: 10,
            walk_forward: 0.5,
            flee_forward: 0.75,
            max_fall_speed: None,
            takes_fall_damage: true,
            loot: items::COW_LOOT,
        },
        MobKind::Pig => &MobSpec {
            width: 0.9,
            height: 0.9,
            head_offset: 0.7,
            health: 10,
            walk_forward: 0.5,
            flee_forward: 0.75,
            max_fall_speed: None,
            takes_fall_damage: true,
            loot: items::PIG_LOOT,
        },
        MobKind::Chicken => &MobSpec {
            width: 0.4,
            height: 0.7,
            head_offset: 0.5,
            health: 4,
            walk_forward: 0.5,
            flee_forward: 0.75,
            max_fall_speed: Some(0.1),
            takes_fall_damage: false,
            loot: items::CHICKEN_LOOT,
        },
    }
}

const HURT_TICKS: u8 = 10;
const LOOT_SALT: u64 = 7;
const WALK_CHANCE: u64 = 120;
const WALK_TICKS: u8 = 100;
const FLEE_TICKS: u8 = 60;
const FLEE_DISTANCE_SALT: u64 = 20;
const FLEE_DIRECTION_SALT: u64 = 21;
const STOP_DISTANCE_SQUARED: f64 = 0.5 * 0.5;
const PROBE_DISTANCE: f64 = 0.7;
const SPAWN_INTERVAL: i64 = 400;
const HERD_KIND_SALT: u64 = 17;
const HERD_KINDS: [MobKind; 3] = [MobKind::Cow, MobKind::Pig, MobKind::Chicken];
const LOCAL_LIMIT: usize = 8;
const EGG_INTERVAL_SALT: u64 = 22;
const MIN_EGG_TICKS: u16 = 6000;
const MAX_EGG_TICKS: u16 = 12000;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Wander {
    Idle,
    Walking {
        target: [f64; 2],
        ticks_left: u8,
        blocked: u8,
    },
    Fleeing {
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
    pub health: u8,
    pub hurt_ticks: u8,
    body: Player,
    ai: Wander,
    fall_start_y: Option<f64>,
    suffocation_ticks: u8,
    lava_ticks: u8,
    last_dry_pos: [f64; 3],
    egg_ticks: Option<u16>,
}

impl Mob {
    fn new(kind: MobKind, pos: [f64; 3]) -> Self {
        let spec = spec(kind);
        Self {
            kind,
            yaw: 0.0,
            age: 0,
            health: spec.health,
            hurt_ticks: 0,
            body: Player::with_size(pos, spec.width, spec.height),
            ai: Wander::Idle,
            fall_start_y: None,
            suffocation_ticks: 0,
            lava_ticks: 0,
            last_dry_pos: pos,
            egg_ticks: None,
        }
    }

    pub fn pos(&self) -> [f64; 3] {
        self.body.position
    }

    pub(crate) fn chunk(&self) -> (i32, i32) {
        let [x, _, z] = self.pos().map(|v| v.floor() as i32);
        (x >> 4, z >> 4)
    }

    pub(crate) fn within_attack_reach(&self, mut eye: [f64; 3]) -> bool {
        eye[1] += physics::EYE_HEIGHT;
        let bounds = self.body.bounds();
        let [dx, dy, dz] = std::array::from_fn(|axis| {
            eye[axis] - eye[axis].clamp(bounds.min[axis], bounds.max[axis])
        });
        dx * dx + dy * dy + dz * dz <= MAX_REACH * MAX_REACH
    }

    pub(crate) fn hurt(
        &mut self,
        world: &World,
        damage: u8,
        (attacker, yaw): ([f64; 3], f32),
        seed: i64,
        id: u32,
        time: i64,
    ) {
        if !self.take_damage(damage) || self.health == 0 {
            return;
        }

        let [x, _, z] = self.pos();
        let (dx, dz) = (x - attacker[0], z - attacker[2]);
        let same_position = dx == 0.0 && dz == 0.0;
        let (dx, dz) = if same_position {
            // Reduce oversized reported angles before indexing the sine table.
            let yaw = f64::from(yaw);
            let degrees = (yaw - (yaw / 360.0).floor() * 360.0).clamp(0.0, 360.0);
            let radians = degrees as f32 * (std::f32::consts::PI / 180.0);
            (-f64::from(sin(radians)), f64::from(cos(radians)))
        } else {
            (dx, dz)
        };
        // Scale the components first so that very small offsets do not underflow.
        let largest = dx.abs().max(dz.abs());
        let (dx, dz) = (dx / largest, dz / largest);
        let length = (dx * dx + dz * dz).sqrt();
        let away = (!same_position).then(|| [dx / length, dz / length]);
        self.start_fleeing(seed, id, time, away);

        let scale = 0.4 / length;
        self.body.velocity[0] = dx * scale;
        self.body.velocity[2] = dz * scale;
        if self.body.is_grounded(&mob_collisions(world)) {
            self.body.velocity[1] = 0.36;
        }
    }

    fn take_damage(&mut self, damage: u8) -> bool {
        if damage == 0 || self.hurt_ticks != 0 {
            return false;
        }
        self.health = self.health.saturating_sub(damage);
        self.hurt_ticks = HURT_TICKS;
        true
    }

    fn start_fleeing(&mut self, seed: i64, id: u32, time: i64, away: Option<[f64; 2]>) {
        self.ai = Wander::Fleeing {
            target: flee_target(self.pos(), seed, id, time, away),
            ticks_left: FLEE_TICKS,
            blocked: 0,
        };
    }

    fn stop_horizontal(&mut self) {
        self.body.velocity[0] = 0.0;
        self.body.velocity[2] = 0.0;
    }

    fn stop(&mut self) {
        self.ai = Wander::Idle;
        self.stop_horizontal();
    }

    fn tick(&mut self, world: &World, seed: i64, id: u32, time: i64) -> Option<DeathCause> {
        self.age = self.age.saturating_add(1);
        let before = self.pos();
        let turn = self.move_body(world, seed, id, time);
        if self.pos()[1] < VOID_Y {
            return None;
        }

        let damage = self.environment_damage(world, before);
        if damage.is_some() {
            if self.health != 0 {
                self.start_fleeing(seed, id, time, None);
            }
        } else if turn {
            let new_target = flee_target(self.pos(), seed, id, time, None);
            if let Wander::Fleeing { target, .. } = &mut self.ai {
                *target = new_target;
            }
        }
        damage
    }

    fn environment_damage(&mut self, world: &World, before: [f64; 3]) -> Option<DeathCause> {
        let pos = self.pos();
        let collisions = mob_collisions(world);
        let grounded = self.body.is_grounded(&collisions);
        let spec = spec(self.kind);
        let fall = track_fall(world, before, pos, &mut self.fall_start_y, grounded);
        let mut cause = None;
        if spec.takes_fall_damage && self.take_damage(fall) {
            cause = Some(DeathCause::Fall);
            if self.health == 0 {
                return cause;
            }
        }

        let head = block_at(world, pos, spec.head_offset);
        if interval(
            &mut self.suffocation_ticks,
            head.is_some_and(blocks::is_full_opaque_cube),
            SUFFOCATION_INTERVAL,
        ) && self.take_damage(SUFFOCATION_DAMAGE)
        {
            cause = Some(DeathCause::Suffocation);
            if self.health == 0 {
                return cause;
            }
        }

        let in_lava = head.is_some_and(blocks::is_lava)
            || block_at(world, pos, LAVA_FEET_OFFSET).is_some_and(blocks::is_lava);
        if !in_lava && grounded && has_loot_support(world, &collisions, pos) {
            self.last_dry_pos = pos;
        }
        if interval(&mut self.lava_ticks, in_lava, LAVA_INTERVAL) && self.take_damage(LAVA_DAMAGE) {
            cause = Some(DeathCause::Lava);
        }
        cause
    }

    // Return whether to pick a new flee target after checking for damage.
    fn move_body(&mut self, world: &World, seed: i64, id: u32, time: i64) -> bool {
        let before = self.pos();
        let [x, y, z] = before;
        let collisions = mob_collisions(world);
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

        let spec = spec(self.kind);
        let idle_input = input;
        let fleeing = matches!(self.ai, Wander::Fleeing { .. });
        let knockback = fleeing && self.hurt_ticks == HURT_TICKS;
        let movement = match self.ai {
            Wander::Walking { target, .. } => Some((target, spec.walk_forward)),
            Wander::Fleeing { target, .. } if !knockback => Some((target, spec.flee_forward)),
            _ => None,
        };
        let mut turn = false;
        let mut step_jump = false;
        if let Some((target, forward)) = movement {
            let dx = target[0] - x;
            let dz = target[1] - z;
            let distance_squared = dx * dx + dz * dz;
            let jump = if distance_squared <= STOP_DISTANCE_SQUARED {
                None
            } else {
                let scale = PROBE_DISTANCE / distance_squared.sqrt();
                let ahead = [x + dx * scale, y, z + dz * scale];
                safe_ahead(world, &collisions, spec, before, ahead)
            };
            if let Some(jump) = jump {
                self.yaw = heading(dx, dz);
                input.yaw = self.yaw;
                input.forward = forward;
                step_jump = jump;
                input.jump |= jump;
            } else if fleeing {
                self.stop_horizontal();
                turn = true;
            } else {
                self.stop();
            }
        }

        let was_rising = !self.body.on_ground && self.body.velocity[1] > 0.0;
        let mut next = self.body;
        next.tick(input, &collisions);
        if input.forward != 0.0 && enters_lava(world, spec, before, next.position) {
            // Horizontal momentum can differ from the intended heading when turning.
            if fleeing {
                self.stop_horizontal();
                turn = true;
            } else {
                self.stop();
            }
            self.body.tick(idle_input, &collisions);
        } else {
            self.body = next;
        }
        if let Some(speed) = spec.max_fall_speed {
            self.body.velocity[1] = self.body.velocity[1].max(-speed);
        }

        if knockback {
            return false;
        }
        let (target, ticks_left, blocked) = match self.ai {
            Wander::Idle => return false,
            Wander::Walking {
                target,
                ticks_left,
                blocked,
            }
            | Wander::Fleeing {
                target,
                ticks_left,
                blocked,
            } => (target, ticks_left, blocked),
        };
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
        let arrived =
            distance_squared(self.pos(), [target[0], 0.0, target[1]]) <= STOP_DISTANCE_SQUARED;
        if ticks_left <= 1 || (!fleeing && (blocked == 2 || arrived)) {
            self.stop();
            return false;
        }

        if fleeing {
            turn |= blocked == 2 || arrived;
            self.ai = Wander::Fleeing {
                target,
                ticks_left: ticks_left - 1,
                blocked: if turn { 0 } else { blocked },
            };
        } else {
            self.ai = Wander::Walking {
                target,
                ticks_left: ticks_left - 1,
                blocked,
            };
        }
        turn
    }

    fn hash_into(&self, h: &mut Fnv64) {
        h.u8(self.kind.wire_id());
        h.u8(self.health);
        h.u8(self.hurt_ticks);
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
            }
            | Wander::Fleeing {
                target,
                ticks_left,
                blocked,
            } => {
                h.u8(if matches!(self.ai, Wander::Walking { .. }) {
                    1
                } else {
                    2
                });
                for v in target {
                    h.bytes(&v.to_bits().to_be_bytes());
                }
                h.u8(ticks_left);
                h.u8(blocked);
            }
        }
        hash_height(h, self.fall_start_y);
        h.u8(self.suffocation_ticks);
        h.u8(self.lava_ticks);
        for v in self.last_dry_pos {
            h.bytes(&v.to_bits().to_be_bytes());
        }
        if let Some(egg_ticks) = self.egg_ticks {
            h.bytes(&egg_ticks.to_be_bytes());
        }
    }
}

fn mob_collisions(world: &World) -> impl CollisionWorld + '_ {
    BlockWorld(|x, y, z| {
        if (MIN_Y..MIN_Y + HEIGHT).contains(&y) {
            // The shared physics treats fluids as swimmable. For mobs only water is swimmable.
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
    })
}

fn has_loot_support(world: &World, collisions: &impl CollisionWorld, [x, y, z]: [f64; 3]) -> bool {
    let [bx, by, bz] = [x, y - 0.01, z].map(|v| v.floor() as i32);
    if world.get_block(bx, by, bz).is_none_or(blocks::is_lava) {
        return false;
    }
    // The mob's footprint can stay grounded while its center is over an edge.
    let mut supported = false;
    collisions.collision_boxes(bx, by, bz, &mut |bounds| {
        supported |= bounds.max[1] <= y
            && (bounds.min[0]..bounds.max[0]).contains(&x)
            && (bounds.min[2]..bounds.max[2]).contains(&z);
    });
    supported
}

/// None means stop. A solid block at foot level can ask physics to jump.
fn safe_ahead(
    world: &World,
    collisions: &impl CollisionWorld,
    spec: &MobSpec,
    before: [f64; 3],
    pos: [f64; 3],
) -> Option<bool> {
    let [x, y, z] = pos.map(|v| v.floor() as i32);
    let foot = world.get_block(x, y, z)?;
    let below = world.get_block(x, y - 1, z)?;
    if blocks::is_lava(below) || enters_lava(world, spec, before, pos) {
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
                && Player::with_size([pos[0], foot_top, pos[2]], spec.width, spec.height)
                    .is_clear(collisions),
        );
    }
    let cutoff = pos[1] - 4.0;
    for floor in (y - 5..=y).rev() {
        let state = world.get_block(x, floor, z)?;
        // Lava at foot level was already checked against the mob's previous bounds.
        if floor < y && blocks::is_lava(state) {
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

fn body_cells(spec: &MobSpec, [x, y, z]: [f64; 3]) -> [RangeInclusive<i32>; 3] {
    let half = spec.width / 2.0;
    [
        (x - half).floor() as i32..=(x + half).floor() as i32,
        y.floor() as i32..=(y + spec.height).floor() as i32,
        (z - half).floor() as i32..=(z + half).floor() as i32,
    ]
}

fn lava_cells<'a>(
    world: &'a World,
    spec: &MobSpec,
    pos: [f64; 3],
) -> impl Iterator<Item = [i32; 3]> + 'a {
    let [xs, ys, zs] = body_cells(spec, pos);
    xs.flat_map(move |x| {
        let ys = ys.clone();
        zs.clone()
            .flat_map(move |z| ys.clone().map(move |y| [x, y, z]))
    })
    .filter(|&[x, y, z]| world.get_block(x, y, z).is_some_and(blocks::is_lava))
}

fn enters_lava(world: &World, spec: &MobSpec, before: [f64; 3], after: [f64; 3]) -> bool {
    let previous = body_cells(spec, before);
    lava_cells(world, spec, after).any(|cell| {
        !previous
            .iter()
            .zip(cell)
            .all(|(range, coordinate)| range.contains(&coordinate))
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

fn flee_target(pos: [f64; 3], seed: i64, id: u32, time: i64, away: Option<[f64; 2]>) -> [f64; 2] {
    let [dx, dz] = away.unwrap_or_else(|| direction(sample(seed, id, time, FLEE_DIRECTION_SALT)));
    let range = 5.0 + (sample(seed, id, time, FLEE_DISTANCE_SALT) % 301) as f64 / 100.0;
    [pos[0] + dx * range, pos[2] + dz * range]
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

fn egg_interval(seed: i64, id: u32, time: i64) -> u16 {
    let range = u64::from(MAX_EGG_TICKS - MIN_EGG_TICKS + 1);
    MIN_EGG_TICKS + (sample(seed, id, time, EGG_INTERVAL_SALT) % range) as u16
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

    pub(crate) fn drop_mob_loot(&mut self, id: u32, mob: Mob, burned: bool) {
        let spec = spec(mob.kind);
        let [x, y, z] = if burned { mob.last_dry_pos } else { mob.pos() };
        for (index, &(item, min, max)) in spec.loot.iter().enumerate() {
            let range = u64::from(max) - u64::from(min) + 1;
            let roll = sample(self.seed, id, self.game_time, LOOT_SALT + index as u64);
            let mut count = min + (roll % range) as u8;
            let item = if burned {
                smelting::output(item).unwrap_or(item)
            } else {
                item
            };
            let max_stack = items::info(item).unwrap().max_stack;
            while count != 0 {
                let stack = count.min(max_stack);
                self.spawn_item(
                    item,
                    stack,
                    [x, y + spec.height / 2.0, z],
                    [0.0, 0.1, 0.0],
                    10,
                );
                count -= stack;
            }
        }
    }

    fn spawn_mob(&mut self, kind: MobKind, pos: [f64; 3]) {
        if let Some(id) = self.allocate_entity_id() {
            let mut mob = Mob::new(kind, pos);
            if kind == MobKind::Chicken {
                mob.egg_ticks = Some(egg_interval(self.seed, id, self.game_time));
            }
            self.mobs.insert(id, mob);
        }
    }

    #[cfg(test)]
    pub(super) fn spawn_cow(&mut self, pos: [f64; 3]) {
        self.spawn_mob(MobKind::Cow, pos);
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
        let kind_roll = sample(self.seed, id, self.game_time, HERD_KIND_SALT);
        let kind = HERD_KINDS[(kind_roll % HERD_KINDS.len() as u64) as usize];
        self.spawn_mob(kind, center);
        let size = (1 + sample(self.seed, id, self.game_time, 5) % 3) as usize;
        let start = (sample(self.seed, id, self.game_time, 6) % HERD_OFFSETS.len() as u64) as usize;
        for offset in 0..size.min(LOCAL_LIMIT - nearby) - 1 {
            let (dx, dz) = HERD_OFFSETS[(start + offset) % HERD_OFFSETS.len()];
            if let Some(candidate) = valid_column(&self.world, x + dx, z + dz) {
                self.spawn_mob(kind, candidate);
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
        let mut hits = Vec::new();
        for (&id, mob) in &mut self.mobs {
            if !self.world.chunks.contains_key(&mob.chunk()) || mob.pos()[1] < VOID_Y {
                continue;
            }
            if let Some(cause) = mob.tick(&self.world, self.seed, id, self.game_time) {
                hits.push((id, cause));
            }
        }
        for (id, cause) in hits {
            if self.mobs[&id].health == 0 {
                let mob = self.mobs.remove(&id).unwrap();
                self.drop_mob_loot(id, mob, cause == DeathCause::Lava);
            } else {
                self.send_mob_hurt(id);
            }
        }
        let mut eggs = Vec::new();
        self.mobs.retain(|&id, mob| {
            let stays = mob.pos()[1] >= VOID_Y
                && self.world.chunks.contains_key(&mob.chunk())
                && players
                    .iter()
                    .any(|&(_, pos)| distance_squared(mob.pos(), pos) <= 128.0 * 128.0);
            if let Some(ticks) = mob.egg_ticks.as_mut().filter(|_| stays && mob.health != 0) {
                *ticks -= 1;
                if *ticks == 0 {
                    *ticks = egg_interval(self.seed, id, self.game_time);
                    eggs.push(mob.pos());
                }
            }
            stays
        });
        for pos in eggs {
            self.spawn_item(items::by_name("egg").unwrap(), 1, pos, [0.0, 0.1, 0.0], 10);
        }
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

    impl Mob {
        fn cow(pos: [f64; 3]) -> Self {
            Self::new(MobKind::Cow, pos)
        }
    }

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
        cow.body.position[2] = 3.0 - spec(MobKind::Cow).width / 2.0;
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
            assert!(cow.pos()[2] < 3.0 - spec(MobKind::Cow).width / 2.0);
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
        cow.body.position[2] = 3.0 - spec(MobKind::Cow).width / 2.0;

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

    fn combat(mode: GameMode) -> (Server, u32) {
        let pos = [5.5, 1.0, 5.5];
        let mut server = Server::new(2026, Generator::Flat);
        server.game_mode = mode;
        server.world = arena(16);
        server.connect_at(1, false, Some(pos), None);
        server.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        server.tick();
        let id = server.next_entity_id;
        server.spawn_cow([pos[0] + 2.0, pos[1], pos[2]]);
        server.tick();
        server.take_outbox();
        (server, id)
    }

    fn attack(server: &mut Server, id: u32) {
        server.handle_packet(1, &C2S::Attack { id }.encode());
    }

    fn hold(server: &mut Server, item: &str) {
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(
                0,
                Some(crate::Stack {
                    item: items::by_name(item).unwrap(),
                    count: 1,
                }),
            )
            .unwrap();
    }

    #[test]
    fn bare_hand_hits_once_per_ten_ticks_and_notifies_spawned_viewers() {
        let (mut server, id) = combat(GameMode::Survival);
        server.connect(2);
        let viewer = server.clients.get_mut(&2).unwrap();
        viewer.joined = true;
        viewer.sent.insert((0, 0));
        server.sync_mobs();
        server.take_outbox();
        server.connect(3);
        server.clients.get_mut(&3).unwrap().joined = true;
        assert!(!server.clients[&3].visible_mobs.contains_key(&id));

        attack(&mut server, id);
        attack(&mut server, id);
        server.tick();
        assert_eq!(
            (server.mobs[&id].health, server.mobs[&id].hurt_ticks),
            (9, 10)
        );
        let hurts: Vec<_> = server
            .take_outbox()
            .into_iter()
            .filter_map(|(client, bytes)| match S2C::decode(&bytes).unwrap() {
                S2C::MobHurt { id } => Some((client, id)),
                _ => None,
            })
            .collect();
        assert_eq!(hurts, [(1, id), (2, id)]);

        for remaining in (1..HURT_TICKS).rev() {
            attack(&mut server, id);
            server.tick();
            assert_eq!(
                (server.mobs[&id].health, server.mobs[&id].hurt_ticks),
                (9, remaining)
            );
        }
        assert!(server
            .take_outbox()
            .iter()
            .all(|(_, bytes)| { !matches!(S2C::decode(bytes), Ok(S2C::MobHurt { .. })) }));
        attack(&mut server, id);
        server.tick();
        assert_eq!(
            (server.mobs[&id].health, server.mobs[&id].hurt_ticks),
            (8, 10)
        );
    }

    #[test]
    fn attack_damage_uses_the_selected_item_in_packet_order_in_both_modes() {
        let tiers = ["wooden", "stone", "copper", "iron"];
        for mode in [GameMode::Survival, GameMode::Creative] {
            let (mut server, id) = combat(mode);
            for (kind, damages) in [
                ("axe", [3, 4, 5, 6]),
                ("pickaxe", [2, 3, 4, 5]),
                ("shovel", [1, 2, 3, 4]),
                ("hoe", [1, 2, 3, 4]),
            ] {
                for (tier, damage) in tiers.into_iter().zip(damages) {
                    let pos = [7.5, 1.0, 5.5];
                    server.mobs.insert(id, Mob::cow(pos));
                    let item = items::by_name(&format!("{tier}_{kind}")).unwrap();
                    server
                        .clients
                        .get_mut(&1)
                        .unwrap()
                        .inventory
                        .set(1, Some(crate::Stack { item, count: 1 }))
                        .unwrap();
                    server.handle_packet(1, &C2S::SelectSlot { slot: 1 }.encode());
                    attack(&mut server, id);
                    server.handle_packet(1, &C2S::SelectSlot { slot: 0 }.encode());
                    server.tick();
                    assert_eq!(server.mobs[&id].health, 10 - damage, "{tier}_{kind}");
                }
            }
            hold(&mut server, "raw_beef");
            server.mobs.insert(id, Mob::cow([7.5, 1.0, 5.5]));
            attack(&mut server, id);
            server.tick();
            assert_eq!(server.mobs[&id].health, 9);
        }
    }

    #[test]
    fn attack_checks_eye_to_box_reach_and_ignores_invalid_targets_or_players() {
        let (mut server, id) = combat(GameMode::Survival);
        let rejected = server.stats.packets_rejected;
        server.mobs.insert(id, Mob::cow([14.0, 1.0, 5.5]));
        attack(&mut server, id);
        server.tick();
        assert_eq!(server.mobs[&id].health, 10);

        // The center is outside reach, but the nearest point on the box is inside.
        server.mobs.insert(id, Mob::cow([13.75, 1.0, 5.5]));
        attack(&mut server, 0);
        attack(&mut server, id + 1);
        server.connect(2);
        server.handle_packet(2, &C2S::Attack { id }.encode());
        server.clients.get_mut(&1).unwrap().health.vitals.dead = true;
        attack(&mut server, id);
        server.tick();
        assert_eq!(server.mobs[&id].health, 10);
        assert_eq!(server.stats.packets_rejected, rejected);

        server.clients.get_mut(&1).unwrap().health.vitals.dead = false;
        attack(&mut server, id);
        server.tick();
        assert_eq!(server.mobs[&id].health, 9);
    }

    #[test]
    fn knockback_replaces_horizontal_velocity_and_lifts_only_grounded_cows() {
        let world = arena(16);
        let mut cow = walking();
        cow.body.on_ground = false; // A newly spawned cow can be supported before its first landing.
        cow.body.velocity = [-0.1, -0.2, -0.3];
        cow.hurt(&world, 1, ([-0.5, 1.0, -2.0], 0.0), 5, 7, 1);
        assert!(matches!(cow.ai, Wander::Fleeing { ticks_left: 60, .. }));
        let [vx, vy, vz] = cow.body.velocity;
        assert!((vx - 0.24).abs() < 1e-12);
        assert!((vz - 0.32).abs() < 1e-12);
        assert_eq!(vy, 0.36);

        let (mut server, id) = combat(GameMode::Creative);
        let [x, y, z] = server.clients[&1].pos;
        let mut cow = Mob::cow([x, y + 1.0, z]);
        cow.body.velocity[1] = 0.2;
        server.mobs.insert(id, cow);
        server.handle_packet(
            1,
            &C2S::PlayerPos {
                x,
                y,
                z,
                yaw: 90.0,
                pitch: 0.0,
            }
            .encode(),
        );
        server.tick();
        // Apply directly to inspect the impulse before movement and friction.
        let upward = server.mobs[&id].body.velocity[1];
        server.apply(1, C2S::Attack { id });
        let [vx, vy, vz] = server.mobs[&id].body.velocity;
        assert!((vx + 0.4).abs() < 1e-12);
        assert!(vz.abs() < 1e-12);
        assert_eq!(vy, upward);
        let cow = server.mobs[&id].clone();
        server.apply(1, C2S::Attack { id });
        assert_eq!(server.mobs[&id], cow);

        let mut cow = Mob::cow([0.0; 3]);
        cow.hurt(&world, 1, ([0.0; 3], f32::MIN), 5, 7, 1);
        let [vx, _, vz] = cow.body.velocity;
        assert!((vx * vx + vz * vz - 0.16).abs() < 1e-12);
        let mut cow = Mob::cow([0.0; 3]);
        cow.hurt(&world, 1, ([-f64::MIN_POSITIVE, 0.0, 0.0], 0.0), 5, 7, 1);
        assert_eq!(cow.body.velocity[0], 0.4);
    }

    #[test]
    fn killing_a_cow_removes_it_and_drops_deterministic_beef() {
        let run = |mode, next_id| {
            let (mut server, id) = combat(mode);
            server.next_entity_id = next_id;
            hold(&mut server, "iron_axe");
            attack(&mut server, id);
            server.tick();
            assert_eq!(server.mobs[&id].health, 4);
            for _ in 1..HURT_TICKS {
                server.tick();
            }
            server.take_outbox();

            let [x, y, z] = server.mobs[&id].pos();
            attack(&mut server, id);
            server.tick();
            assert!(!server.mobs.contains_key(&id));
            let packets: Vec<_> = server
                .take_outbox()
                .into_iter()
                .map(|(client, bytes)| (client, S2C::decode(&bytes).unwrap()))
                .collect();
            assert!(packets.contains(&(1, S2C::EntityRemove { id })));
            assert!(!packets.contains(&(1, S2C::MobHurt { id })));
            assert_eq!(server.entities.len(), 1);
            let drop = &server.entities[&next_id];
            assert_eq!(drop.item, items::by_name("raw_beef").unwrap());
            assert!((1..=3).contains(&drop.count));
            // The drop advances once with gravity during the tick that spawns it.
            assert_eq!(drop.pos, [x, y + 0.65 + (0.1 - 0.04), z]);
            assert_eq!(drop.pickup_delay, 9);
            drop.count
        };
        let count = run(GameMode::Survival, 2);
        assert_eq!(run(GameMode::Creative, 2), count);
        assert_eq!(run(GameMode::Survival, 2), count);
        assert_eq!(run(GameMode::Survival, 50), count);
    }

    fn flee_state(cow: &Mob) -> ([f64; 2], u8, u8) {
        match cow.ai {
            Wander::Fleeing {
                target,
                ticks_left,
                blocked,
            } => (target, ticks_left, blocked),
            ai => panic!("expected fleeing, got {ai:?}"),
        }
    }

    #[test]
    fn fall_damage_starts_at_four_blocks_and_water_breaks_the_fall() {
        let dry = arena(16);
        let mut wet = arena(16);
        wet.set_block(2, 1, 2, blocks::WATER);
        let time = (1..)
            .find(|&t| !sample(5, 7, t, 0).is_multiple_of(WALK_CHANCE))
            .unwrap();
        for (world, start, damage, water) in [
            (&dry, 5.0, 1, false),
            (&dry, 4.0, 0, false),
            (&wet, 7.25, 0, true),
        ] {
            let mut cow = Mob::cow([2.5, start, 2.5]);
            let cause = (0..40)
                .find_map(|_| {
                    let cause = cow.tick(world, 5, 7, time);
                    let landed = if water {
                        block_at(world, cow.pos(), 0.0).is_some_and(blocks::is_water)
                    } else {
                        cow.body.is_grounded(&mob_collisions(world))
                    };
                    landed.then_some(cause)
                })
                .expect("cow reached the floor or water");
            assert_eq!(cow.health, spec(MobKind::Cow).health - damage);
            assert_eq!(cow.fall_start_y, None);
            if damage == 0 {
                assert_eq!(cause, None);
                assert_eq!(cow.hurt_ticks, 0);
                assert_eq!(cow.ai, Wander::Idle);
            } else {
                assert_eq!(cause, Some(DeathCause::Fall));
                assert_eq!(cow.hurt_ticks, HURT_TICKS);
                assert_eq!(flee_state(&cow).1, FLEE_TICKS);
            }
            if !water {
                assert_eq!(cow.pos()[1], 1.0);
            }
        }
    }

    #[test]
    fn immune_landing_consumes_the_fall_without_delayed_damage() {
        let (mut server, id) = combat(GameMode::Creative);
        let cow = server.mobs.get_mut(&id).unwrap();
        cow.body.position[1] = 1.25;
        cow.body.velocity[1] = -0.5;
        cow.fall_start_y = Some(6.0);
        cow.hurt_ticks = HURT_TICKS;
        server.tick();
        let cow = &server.mobs[&id];
        assert_eq!(cow.pos()[1], 1.0);
        assert_eq!(cow.fall_start_y, None);
        assert_eq!(cow.health, spec(MobKind::Cow).health);
        for _ in 1..HURT_TICKS {
            server.tick();
        }
        assert_eq!(server.mobs[&id].health, spec(MobKind::Cow).health);
    }

    #[test]
    fn pig_body_uses_its_own_dimensions_and_head_height() {
        let mut world = arena(16);
        let pos = [2.5, 1.0, 2.5];
        let mut pig = Mob::new(MobKind::Pig, pos);
        let bounds = pig.body.bounds();
        assert_eq!(bounds.min, [2.5 - 0.45, 1.0, 2.5 - 0.45]);
        assert_eq!(bounds.max, [2.5 + 0.45, 1.0 + 0.9, 2.5 + 0.45]);
        assert_eq!(pig.health, 10);

        // At the same horizontal distance the cow is reachable from higher up.
        let eye_base = [
            pos[0] + MAX_REACH + 0.45,
            pos[1] + 1.1 - physics::EYE_HEIGHT,
            pos[2],
        ];
        assert!(Mob::cow(pos).within_attack_reach(eye_base));
        assert!(!pig.within_attack_reach(eye_base));

        // A block at y=2 is above the pig's head until its feet rise by 0.4.
        world.set_block(2, 2, 2, blocks::STONE);
        for _ in 0..SUFFOCATION_INTERVAL {
            assert_eq!(pig.environment_damage(&world, pos), None);
        }
        pig.body.position[1] = 1.4;
        for _ in 1..SUFFOCATION_INTERVAL {
            assert_eq!(pig.environment_damage(&world, pig.pos()), None);
        }
        assert_eq!(
            pig.environment_damage(&world, pig.pos()),
            Some(DeathCause::Suffocation)
        );
        assert_eq!(pig.health, 9);
    }

    #[test]
    fn killed_pigs_drop_raw_porkchops_and_lava_cooks_them() {
        for (burned, expected_item) in [(false, 64), (true, 65)] {
            let (mut server, id) = combat(GameMode::Creative);
            let pos = server.mobs[&id].pos();
            server.mobs.insert(id, Mob::new(MobKind::Pig, pos));
            let drop_y = if burned {
                server.world.set_block(7, 1, 5, blocks::LAVA);
                for (x, z) in [(6, 5), (8, 5), (7, 4), (7, 6)] {
                    for y in 1..=2 {
                        server.world.set_block(x, y, z, blocks::STONE);
                    }
                }
                for _ in 0..3 * LAVA_INTERVAL {
                    server.tick();
                }
                pos[1] + 0.45
            } else {
                hold(&mut server, "iron_axe");
                attack(&mut server, id);
                server.tick();
                assert_eq!(server.mobs[&id].health, 4);
                for _ in 1..HURT_TICKS {
                    server.tick();
                }
                let feet_y = server.mobs[&id].pos()[1];
                attack(&mut server, id);
                server.tick();
                feet_y + 0.45 + (0.1 - 0.04)
            };
            assert!(!server.mobs.contains_key(&id));
            assert_eq!(server.entities.len(), 1);
            let drop = server.entities.values().next().unwrap();
            assert_eq!(drop.item, expected_item);
            assert!((1..=3).contains(&drop.count));
            assert_eq!(drop.pos[1], drop_y);
        }
        assert_eq!(items::PIG_LOOT, [(64, 1, 3)]);
    }

    #[test]
    fn chicken_body_uses_its_own_dimensions_health_and_head_height() {
        let mut world = arena(16);
        let pos = [2.5, 1.25, 2.5];
        let mut chicken = Mob::new(MobKind::Chicken, pos);
        let bounds = chicken.body.bounds();
        assert_eq!(bounds.min, [2.5 - 0.2, 1.25, 2.5 - 0.2]);
        assert_eq!(bounds.max, [2.5 + 0.2, 1.25 + 0.7, 2.5 + 0.2]);
        assert_eq!(chicken.health, 4);
        assert_eq!(spec(MobKind::Chicken).head_offset, 0.5);

        world.set_block(2, 2, 2, blocks::STONE);
        for _ in 0..SUFFOCATION_INTERVAL {
            assert_eq!(chicken.environment_damage(&world, pos), None);
        }
        chicken.body.position[1] = 1.5;
        for _ in 1..SUFFOCATION_INTERVAL {
            assert_eq!(chicken.environment_damage(&world, chicken.pos()), None);
        }
        assert_eq!(
            chicken.environment_damage(&world, chicken.pos()),
            Some(DeathCause::Suffocation)
        );
        assert_eq!(chicken.health, 3);
    }

    #[test]
    fn chicken_falls_slowly_and_lands_without_damage() {
        let world = arena(16);
        let mut chicken = Mob::new(MobKind::Chicken, [8.5, 21.0, 8.5]);
        let collisions = mob_collisions(&world);
        let mut reached_limit = false;
        for time in 1..=220 {
            assert_eq!(chicken.tick(&world, 5, 7, time), None);
            assert!(chicken.body.velocity[1] >= -0.1);
            reached_limit |= chicken.body.velocity[1] == -0.1;
            if chicken.body.is_grounded(&collisions) {
                assert!(time >= 200);
                break;
            }
        }
        assert!(reached_limit);
        assert_eq!(chicken.pos()[1], 1.0);
        assert_eq!(chicken.health, 4);
        assert_eq!(chicken.fall_start_y, None);
    }

    #[test]
    fn chicken_egg_timer_is_deterministic_and_restarts_after_one_drop() {
        let run = || {
            let (mut server, _) = combat(GameMode::Creative);
            let pos = [7.5, 1.0, 5.5];
            let id = server.next_entity_id;
            let spawn_time = server.game_time;
            server.spawn_mob(MobKind::Chicken, pos);
            let initial = server.mobs[&id].egg_ticks.unwrap();
            assert_eq!(initial, egg_interval(server.seed, id, spawn_time));
            assert!((6000..=12000).contains(&initial));

            let hash = server.state_hash();
            server.mobs.get_mut(&id).unwrap().egg_ticks = Some(2);
            assert_ne!(server.state_hash(), hash);
            server.tick();
            assert_eq!(server.mobs[&id].egg_ticks, Some(1));
            assert!(server.entities.is_empty());

            server.spawn_mob(MobKind::Chicken, [pos[0], VOID_Y - 1.0, pos[2]]);
            let despawning = id + 1;
            server.mobs.get_mut(&despawning).unwrap().egg_ticks = Some(1);
            server.tick();
            assert!(!server.mobs.contains_key(&despawning));
            assert_eq!(server.entities.len(), 1);
            let egg = server.entities.values().next().unwrap();
            assert_eq!((egg.item, egg.count, egg.pickup_delay), (66, 1, 10));
            assert_eq!(egg.pos, server.mobs[&id].pos());
            assert_eq!(egg.velocity, [0.0, 0.1, 0.0]);
            let next = server.mobs[&id].egg_ticks.unwrap();
            assert_eq!(next, egg_interval(server.seed, id, server.game_time));
            assert!((6000..=12000).contains(&next));
            assert_ne!(next, initial);
            (initial, next)
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn chicken_drops_meat_and_feathers_and_lava_cooks_only_the_meat() {
        for (burned, meat) in [(false, 67), (true, 68)] {
            let (mut server, id) = combat(GameMode::Creative);
            let pos = server.mobs[&id].pos();
            server.mobs.insert(id, Mob::new(MobKind::Chicken, pos));
            if burned {
                server.world.set_block(7, 1, 5, blocks::LAVA);
                for _ in 1..LAVA_INTERVAL {
                    server.tick();
                }
                assert_eq!(server.mobs[&id].health, 4);
            } else {
                hold(&mut server, "iron_axe");
                attack(&mut server, id);
            }
            server.mobs.get_mut(&id).unwrap().egg_ticks = Some(1);
            server.tick();
            assert!(!server.mobs.contains_key(&id));
            let drops: Vec<_> = server
                .entities
                .values()
                .map(|drop| (drop.item, drop.count))
                .collect();
            assert_eq!(drops[0], (meat, 1));
            let feather_count =
                (sample(server.seed, id, server.game_time, LOOT_SALT + 1) % 3) as u8;
            let feathers = (feather_count != 0).then_some((69, feather_count));
            assert_eq!(&drops[1..], feathers.as_slice());
        }
        assert_eq!(items::CHICKEN_LOOT, [(67, 1, 1), (69, 0, 2)]);
    }

    #[test]
    fn lava_at_feet_or_head_burns_loot_after_three_damage_intervals() {
        let run = |y, lava| {
            let (mut server, id) = combat(GameMode::Creative);
            let dry = [5.5, 1.0, 8.5];
            let trapped = server.mobs[&id].pos();
            server.mobs.get_mut(&id).unwrap().body.position = dry;
            server.tick();
            assert_eq!(server.mobs[&id].last_dry_pos, dry);
            server.mobs.get_mut(&id).unwrap().body.position = trapped;
            // The center is the only open column, keeping the cow inside the lava.
            server.world.set_block(7, y, 5, lava);
            for (x, z) in [(6, 5), (8, 5), (7, 4), (7, 6)] {
                for y in 1..=3 {
                    server.world.set_block(x, y, z, blocks::STONE);
                }
            }
            server.connect_at(2, false, Some([1024.5, 1.0, 1024.5]), None);
            server.clients.get_mut(&2).unwrap().joined = true;
            for tick in 1..=30 {
                assert!(!server.clients[&2].visible_mobs.contains_key(&id));
                server.tick();
                let packets: Vec<_> = server
                    .take_outbox()
                    .into_iter()
                    .map(|(client, bytes)| (client, S2C::decode(&bytes).unwrap()))
                    .collect();
                let hurts: Vec<_> = packets
                    .iter()
                    .filter(|(_, packet)| *packet == S2C::MobHurt { id })
                    .collect();
                if tick < 30 {
                    assert_eq!(server.mobs[&id].health, 10 - 4 * (tick / 10), "tick {tick}");
                    if tick % 10 == 0 {
                        assert_eq!(hurts, [&(1, S2C::MobHurt { id })]);
                        let cow = &server.mobs[&id];
                        assert_eq!(cow.hurt_ticks, HURT_TICKS);
                        assert_eq!(flee_state(cow).1, FLEE_TICKS);
                        assert_eq!([cow.body.velocity[0], cow.body.velocity[2]], [0.0; 2]);
                    } else {
                        assert!(hurts.is_empty());
                    }
                    assert!(server.entities.is_empty());
                } else {
                    assert!(!server.mobs.contains_key(&id));
                    assert!(hurts.is_empty());
                    assert!(packets.contains(&(1, S2C::EntityRemove { id })));
                }
            }
            assert_eq!(server.entities.len(), 1);
            let (&drop_id, drop) = server.entities.iter().next().unwrap();
            assert_eq!(drop.item, items::by_name("cooked_beef").unwrap());
            assert!((1..=3).contains(&drop.count));
            let [x, y, z] = dry;
            assert_eq!(drop.pos, [x, y + 0.65, z]);
            assert_eq!(drop.pickup_delay, 10);
            let stack = crate::Stack {
                item: drop.item,
                count: drop.count,
            };
            for _ in 0..10 {
                server.tick();
            }
            let drop = &server.entities[&drop_id];
            assert_eq!(drop.pickup_delay, 0);
            assert_eq!((drop.item, drop.count), (stack.item, stack.count));

            server.clients.get_mut(&1).unwrap().pos = dry;
            server.tick();
            assert!(server.entities.is_empty());
            assert!(server.clients[&1].inventory.slots().contains(&Some(stack)));
            stack.count
        };
        let count = run(1, blocks::LAVA);
        assert_eq!(run(1, blocks::LAVA), count);
        assert_eq!(run(2, blocks::LAVA), count);
        assert_eq!(run(1, blocks::FLOWING_LAVA), count);
    }

    #[test]
    fn lava_death_after_a_fall_drops_loot_on_the_ledge() {
        let (mut server, id) = combat(GameMode::Creative);
        let ledge = [7.95, 8.0, 5.5];
        // A lava-filled shaft with a ledge to the west and a higher wall to the east.
        server.world.set_block(8, 1, 5, blocks::LAVA);
        for (x, z) in [(7, 5), (9, 5), (8, 4), (8, 6)] {
            for y in 1..=7 {
                server.world.set_block(x, y, z, blocks::STONE);
            }
        }
        for y in 8..=9 {
            server.world.set_block(9, y, 5, blocks::STONE);
        }
        server.mobs.get_mut(&id).unwrap().body.position = ledge;
        server.tick();
        assert_eq!(server.mobs[&id].last_dry_pos, ledge);

        server.mobs.get_mut(&id).unwrap().body.velocity[0] = 0.3;
        server.tick();
        let cow = &server.mobs[&id];
        // The cow still overlaps the ledge, but loot centered here would miss it.
        assert!(cow.pos()[0] > 8.125);
        assert!(cow.body.is_grounded(&mob_collisions(&server.world)));
        assert!((0..80).any(|_| {
            server.tick();
            !server.mobs.contains_key(&id)
        }));

        assert_eq!(server.entities.len(), 1);
        let (&drop_id, drop) = server.entities.iter().next().unwrap();
        let stack = crate::Stack {
            item: drop.item,
            count: drop.count,
        };
        assert_eq!(stack.item, items::by_name("cooked_beef").unwrap());
        assert!((1..=3).contains(&stack.count));
        assert_eq!(drop.pos, [ledge[0], ledge[1] + 0.65, ledge[2]]);
        assert_eq!(drop.pickup_delay, 10);
        for _ in 0..10 {
            server.tick();
        }
        assert_eq!(server.entities[&drop_id].pickup_delay, 0);

        server.clients.get_mut(&1).unwrap().pos = ledge;
        server.tick();
        assert!(server.entities.is_empty());
        assert!(server.clients[&1].inventory.slots().contains(&Some(stack)));
    }

    #[test]
    fn lava_uses_the_feet_offset_above_the_position() {
        let mut world = arena(0);
        world.set_block(2, 1, 2, blocks::LAVA);
        let mut cow = Mob::cow([2.5, 0.95, 2.5]);
        cow.lava_ticks = LAVA_INTERVAL - 1;
        let time = (1..)
            .find(|&t| !sample(5, 7, t, 0).is_multiple_of(WALK_CHANCE))
            .unwrap();
        assert_eq!(cow.tick(&world, 5, 7, time), Some(DeathCause::Lava));
        assert_eq!(cow.health, spec(MobKind::Cow).health - LAVA_DAMAGE);
        assert_eq!(block_at(&world, cow.pos(), 0.0), Some(blocks::AIR));
        assert_eq!(
            block_at(&world, cow.pos(), spec(MobKind::Cow).head_offset),
            Some(blocks::AIR)
        );
    }

    #[test]
    fn lava_damage_makes_a_cow_flee_from_an_isolated_lava_cell() {
        let mut world = arena(16);
        world.set_block(7, 1, 7, blocks::LAVA);
        let mut cow = Mob::cow([7.5, 1.0, 7.5]);
        cow.lava_ticks = LAVA_INTERVAL - 1;
        let time = (1..)
            .find(|&t| !sample(5, 7, t, 0).is_multiple_of(WALK_CHANCE))
            .unwrap();
        assert_eq!(cow.tick(&world, 5, 7, time), Some(DeathCause::Lava));
        assert_eq!(flee_state(&cow).1, FLEE_TICKS);
        let escaped = (time + 1..=time + i64::from(FLEE_TICKS)).any(|tick| {
            cow.hurt_ticks = cow.hurt_ticks.saturating_sub(1);
            cow.tick(&world, 5, 7, tick);
            lava_cells(&world, spec(MobKind::Cow), cow.pos())
                .next()
                .is_none()
        });
        assert!(escaped);
        assert!(cow.health > 0);
        assert_eq!(cow.last_dry_pos, cow.pos());
    }

    fn cover_cow(server: &mut Server, state: u16) {
        for x in 2..14 {
            for z in 2..14 {
                server.world.set_block(x, 2, z, state);
            }
        }
    }

    #[test]
    fn suffocation_requires_a_full_opaque_cube_at_the_head() {
        for (head, damage) in [
            (blocks::STONE, 1),
            (blocks::OAK_SLAB + 1, 0),
            (blocks::GLASS, 0),
        ] {
            let (mut server, id) = combat(GameMode::Creative);
            cover_cow(&mut server, head);
            for tick in 1..=20 {
                server.tick();
                assert_eq!(
                    server.mobs[&id].health,
                    10 - damage * (tick / 10),
                    "tick {tick}"
                );
            }
        }
    }

    #[test]
    fn immunity_discards_due_hazard_damage_and_the_interval_keeps_running() {
        for (head, period, damage) in [
            (blocks::STONE, SUFFOCATION_INTERVAL, SUFFOCATION_DAMAGE),
            (blocks::LAVA, LAVA_INTERVAL, LAVA_DAMAGE),
        ] {
            let (mut server, id) = combat(GameMode::Creative);
            cover_cow(&mut server, head);
            let cow = server.mobs.get_mut(&id).unwrap();
            cow.hurt_ticks = HURT_TICKS;
            cow.suffocation_ticks = period - 1;
            cow.lava_ticks = period - 1;
            server.tick();
            assert_eq!(
                (server.mobs[&id].health, server.mobs[&id].hurt_ticks),
                (10, 9)
            );
            assert_eq!(
                (
                    server.mobs[&id].suffocation_ticks,
                    server.mobs[&id].lava_ticks
                ),
                (0, 0)
            );
            for _ in 1..period {
                server.tick();
                assert_eq!(server.mobs[&id].health, 10);
            }
            server.tick();
            assert_eq!(
                (server.mobs[&id].health, server.mobs[&id].hurt_ticks),
                (10 - damage, 10)
            );
        }
    }

    #[test]
    fn falling_takes_priority_over_suffocation_and_death_drops_raw_beef() {
        let (mut server, id) = combat(GameMode::Creative);
        cover_cow(&mut server, blocks::STONE);
        let cow = server.mobs.get_mut(&id).unwrap();
        cow.fall_start_y = Some(6.0);
        cow.suffocation_ticks = SUFFOCATION_INTERVAL - 1;
        server.tick();
        let cow = &server.mobs[&id];
        assert_eq!(cow.health, 8);
        assert_eq!(cow.suffocation_ticks, 0);
        let cow = server.mobs.get_mut(&id).unwrap();
        cow.health = 1;
        cow.hurt_ticks = 0;
        cow.suffocation_ticks = SUFFOCATION_INTERVAL - 1;
        server.tick();
        assert!(!server.mobs.contains_key(&id));
        assert_eq!(server.entities.len(), 1);
        assert_eq!(
            server.entities.values().next().unwrap().item,
            items::by_name("raw_beef").unwrap()
        );
    }

    #[test]
    fn attack_flees_away_faster_than_walking_for_sixty_ticks_and_repeats() {
        let run = || {
            let (mut server, id) = combat(GameMode::Creative);
            let start = server.mobs[&id].pos();
            attack(&mut server, id);
            server.tick();
            let cow = &server.mobs[&id];
            let (target, ticks_left, _) = flee_state(cow);
            assert_eq!(ticks_left, 60);
            assert_eq!(target[1], start[2]);
            assert!((5.0..=8.0).contains(&(target[0] - start[0])));
            assert_eq!(cow.pos(), [start[0] + 0.4, start[1] + 0.36, start[2]]);

            let mut walker = cow.clone();
            walker.ai = Wander::Walking {
                target,
                ticks_left: WALK_TICKS,
                blocked: 0,
            };
            let mut route = vec![cow.pos()];
            for elapsed in 1..=60 {
                let last_walk = walker.pos();
                walker.tick(&server.world, server.seed, id, server.game_time + 1);
                let last_flee = server.mobs[&id].pos();
                server.tick();
                let cow = &server.mobs[&id];
                if elapsed < 60 {
                    assert_eq!(flee_state(cow).1, 60 - elapsed);
                } else {
                    assert_eq!(cow.ai, Wander::Idle);
                }
                if (18..=22).contains(&elapsed) {
                    let walk = walker.pos()[0] - last_walk[0];
                    let flee = cow.pos()[0] - last_flee[0];
                    assert!((0.10..0.12).contains(&walk), "{walk}");
                    assert!((0.15..0.17).contains(&flee), "{flee}");
                }
                route.push(cow.pos());
            }
            route
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn a_second_attack_refreshes_flee_time_and_target() {
        let (mut server, id) = combat(GameMode::Survival);
        attack(&mut server, id);
        server.tick();
        let first = flee_state(&server.mobs[&id]).0;
        for _ in 1..HURT_TICKS {
            server.tick();
        }
        assert_eq!(flee_state(&server.mobs[&id]).1, 51);

        let before = server.mobs[&id].pos();
        let time = server.game_time;
        attack(&mut server, id);
        server.tick();
        let cow = &server.mobs[&id];
        let (target, ticks_left, _) = flee_state(cow);
        assert_eq!(cow.health, 8);
        assert_eq!(ticks_left, 60);
        assert_ne!(target, first);
        assert_eq!(
            target,
            flee_target(before, server.seed, id, time, Some([1.0, 0.0]))
        );
    }

    fn fleeing_toward(target: [f64; 2]) -> Mob {
        let mut cow = walking();
        cow.ai = Wander::Fleeing {
            target,
            ticks_left: FLEE_TICKS,
            blocked: 0,
        };
        cow
    }

    #[test]
    fn fleeing_retargets_before_a_cliff_or_lava() {
        let cliff = arena(3);
        let mut lava = arena(16);
        for x in 0..16 {
            for z in 3..16 {
                lava.set_block(x, 1, z, blocks::LAVA);
            }
        }
        for world in [cliff, lava] {
            let mut cow = fleeing_toward([2.5, 9.0]);
            let first = flee_state(&cow).0;
            let mut turned = false;
            for tick in 1..=19 {
                cow.tick(&world, 5, 7, tick);
                assert_eq!(cow.pos()[1], 1.0);
                assert!(cow.body.is_grounded(&mob_collisions(&world)));
                assert!(lava_cells(&world, spec(MobKind::Cow), cow.pos())
                    .next()
                    .is_none());
                let (target, left, blocked) = flee_state(&cow);
                assert_eq!(left, 60 - tick as u8);
                if !turned && target != first {
                    assert_eq!(target, flee_target(cow.pos(), 5, 7, tick, None));
                    assert_eq!(blocked, 0);
                    assert_eq!([cow.body.velocity[0], cow.body.velocity[2]], [0.0; 2]);
                    turned = true;
                }
            }
            assert!(turned);
        }
    }

    #[test]
    fn fleeing_rejects_momentum_into_lava_and_retargets_without_moving() {
        let mut world = arena(16);
        world.set_block(2, 1, 3, blocks::LAVA);
        let mut cow = fleeing_toward([9.0, 2.0]);
        cow.body.velocity[2] = 0.8;
        let before = cow.pos();
        cow.tick(&world, 5, 7, 1);
        assert_eq!(cow.pos(), before);
        assert_eq!(
            flee_state(&cow),
            (flee_target(before, 5, 7, 1, None), 59, 0)
        );
    }

    #[test]
    fn fleeing_cow_at_lava_edge_avoids_new_lava_cells() {
        let mut world = arena(16);
        world.set_block(2, 1, 2, blocks::LAVA);
        world.set_block(2, 1, 3, blocks::LAVA);
        for (target, velocity) in [([2.5, 9.0], 0.0), ([9.0, 2.5], 0.8)] {
            let mut cow = fleeing_toward(target);
            cow.body.position = [2.5, 1.0, 2.5];
            cow.body.velocity[2] = velocity;
            let before = cow.pos();
            assert!(lava_cells(&world, spec(MobKind::Cow), before).eq([[2, 1, 2]]));
            cow.tick(&world, 5, 7, 1);
            assert_eq!(cow.pos(), before);
            assert_eq!(
                flee_state(&cow),
                (flee_target(before, 5, 7, 1, None), 59, 0)
            );
        }
    }

    #[test]
    fn fleeing_retargets_after_two_blocked_ticks_or_on_arrival() {
        let mut world = arena(16);
        world.set_block(2, 1, 3, blocks::STONE);
        world.set_block(2, 2, 3, blocks::STONE);
        let first = [2.5, 9.0];
        let mut cow = fleeing_toward(first);
        cow.body.position[2] = 3.0 - spec(MobKind::Cow).width / 2.0;
        cow.tick(&world, 5, 7, 1);
        assert_eq!(flee_state(&cow), (first, 59, 1));
        cow.tick(&world, 5, 7, 2);
        assert_eq!(
            flee_state(&cow),
            (flee_target(cow.pos(), 5, 7, 2, None), 58, 0)
        );

        let mut cow = fleeing_toward([2.5, 2.5]);
        let before = cow.pos();
        cow.tick(&world, 5, 7, 3);
        assert_eq!(cow.pos(), before);
        assert_eq!(
            flee_state(&cow),
            (flee_target(before, 5, 7, 3, None), 59, 0)
        );
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
            assert!(server.mobs().values().all(|mob| mob.kind == MobKind::Cow));
            let herd: Vec<_> = server.mobs().values().map(Mob::pos).collect();
            assert!((1..=3).contains(&herd.len()));
            for &[x, y, z] in &herd {
                let distance = distance_squared(server.spawn(), [x, y, z]);
                assert!((24.0 * 24.0..=48.0 * 48.0).contains(&distance));
                assert!(distance_squared(herd[0], [x, y, z]) <= 4.0);
                assert_eq!(
                    server.get_block(x.floor() as i32, y.floor() as i32 - 1, z.floor() as i32),
                    Some(blocks::GRASS_BLOCK)
                );
            }
            assert_eq!(herd, expected);
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
    fn pig_and_chicken_herds_are_uniform_and_independent_of_entity_ids() {
        let mut server = joined(GameMode::Creative);
        let pos = server.spawn();
        let players = [(1, pos)];
        for (tick, count, expected) in [
            (800, 1, MobKind::Pig),
            (1200, 2, MobKind::Pig),
            (2000, 1, MobKind::Chicken),
            (2400, 2, MobKind::Chicken),
            (2800, 1, MobKind::Pig),
            (3600, 1, MobKind::Chicken),
            (5200, 2, MobKind::Pig),
        ] {
            server.game_time = tick;
            let mut spawn = || {
                server.spawn_herd(1, pos, &players);
                let herd: Vec<_> = server
                    .mobs
                    .values()
                    .map(|mob| (mob.kind, mob.pos()))
                    .collect();
                server.mobs.clear();
                herd
            };
            let herd = spawn();
            assert_eq!(herd.len(), count);
            assert!(herd.iter().all(|&(kind, _)| kind == expected));
            assert_eq!(spawn(), herd);
        }
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
        for kind in [
            MobKind::Cow,
            MobKind::Pig,
            MobKind::Pig,
            MobKind::Pig,
            MobKind::Cow,
            MobKind::Cow,
            MobKind::Pig,
        ] {
            server.spawn_mob(kind, pos);
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
        server.mobs.get_mut(&id).unwrap().health -= 1;
        assert_ne!(server.state_hash(), hash);
        let hash = server.state_hash();
        server.mobs.get_mut(&id).unwrap().hurt_ticks = 10;
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
