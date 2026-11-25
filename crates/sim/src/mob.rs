//! Transient mobs and their deterministic spawning and movement.
use std::collections::BTreeMap;
use std::ops::RangeInclusive;

use jmath::sin_table::{cos, sin};
use physics::{BlockWorld, CollisionWorld, Input, Player};
pub use protocol::MobKind;
use protocol::{DeathCause, WoolColor, S2C};
use world::{blocks, items, smelting, Fnv64, World, HEIGHT, MIN_Y};

use crate::{
    arrow::{clear_sight, Arrow},
    health::{
        block_at, hash_height, interval, track_fall, LAVA_DAMAGE, LAVA_FEET_OFFSET, LAVA_INTERVAL,
        SUFFOCATION_DAMAGE, SUFFOCATION_INTERVAL, VOID_Y,
    },
    GameMode, Server, MAX_REACH,
};

struct MobSpec {
    width: f64,
    height: f64,
    head_offset: f64,
    health: u8,
    walk_forward: f32,
    flee_forward: f32,
    chase_forward: Option<f32>,
    max_fall_speed: Option<f64>,
    takes_fall_damage: bool,
    burns_in_sunlight: bool,
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
            chase_forward: None,
            max_fall_speed: None,
            takes_fall_damage: true,
            burns_in_sunlight: false,
            loot: items::COW_LOOT,
        },
        MobKind::Pig => &MobSpec {
            width: 0.9,
            height: 0.9,
            head_offset: 0.7,
            health: 10,
            walk_forward: 0.5,
            flee_forward: 0.75,
            chase_forward: None,
            max_fall_speed: None,
            takes_fall_damage: true,
            burns_in_sunlight: false,
            loot: items::PIG_LOOT,
        },
        MobKind::Chicken => &MobSpec {
            width: 0.4,
            height: 0.7,
            head_offset: 0.5,
            health: 4,
            walk_forward: 0.5,
            flee_forward: 0.75,
            chase_forward: None,
            max_fall_speed: Some(0.1),
            takes_fall_damage: false,
            burns_in_sunlight: false,
            loot: items::CHICKEN_LOOT,
        },
        MobKind::Sheep => &MobSpec {
            width: 0.9,
            height: 1.3,
            head_offset: 1.1,
            health: 8,
            walk_forward: 0.5,
            flee_forward: 0.75,
            chase_forward: None,
            max_fall_speed: None,
            takes_fall_damage: true,
            burns_in_sunlight: false,
            loot: items::SHEEP_LOOT,
        },
        MobKind::Zombie => &MobSpec {
            width: 0.6,
            height: 1.95,
            head_offset: 1.74,
            health: 20,
            walk_forward: 0.5,
            flee_forward: 0.0,
            chase_forward: Some(0.6),
            max_fall_speed: None,
            takes_fall_damage: true,
            burns_in_sunlight: true,
            loot: items::ZOMBIE_LOOT,
        },
        MobKind::Skeleton => &MobSpec {
            width: 0.6,
            height: 1.99,
            head_offset: 1.74,
            health: 20,
            walk_forward: 0.5,
            flee_forward: 0.0,
            chase_forward: Some(0.6),
            max_fall_speed: None,
            takes_fall_damage: true,
            burns_in_sunlight: true,
            loot: items::SKELETON_LOOT,
        },
        MobKind::Creeper => &MobSpec {
            width: 0.6,
            height: 1.7,
            head_offset: 1.45,
            health: 20,
            walk_forward: 0.5,
            flee_forward: 0.0,
            chase_forward: Some(0.6),
            max_fall_speed: None,
            takes_fall_damage: true,
            burns_in_sunlight: false,
            loot: items::CREEPER_LOOT,
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
const HERD_KINDS: [MobKind; 4] = [MobKind::Cow, MobKind::Pig, MobKind::Chicken, MobKind::Sheep];
const LOCAL_LIMIT: usize = 8;
const EGG_INTERVAL_SALT: u64 = 22;
const WOOL_COLOR_SALT: u64 = 28;
const SHEAR_LOOT_SALT: u64 = 29;
const WOOL_REGROW_TICKS: u16 = 2400;
const MIN_EGG_TICKS: u16 = 6000;
const MAX_EGG_TICKS: u16 = 12000;
const HOSTILE_SPAWN_INTERVAL: i64 = 200;
const HOSTILE_COLUMN_SALT: u64 = 23;
const HOSTILE_KIND_SALT: u64 = 24;
const HOSTILE_DARK_COLUMN_SALT: u64 = 26;
const HOSTILE_DARK_KIND_SALT: u64 = 27;
const HOSTILE_DARK_DESCENT: i32 = 16;
const SKELETON_STOP_RANGE: f64 = 10.0;
const SKELETON_INITIAL_SHOT_TICKS: u8 = 20;
const SKELETON_SHOT_INTERVAL: u8 = 40;
const HOSTILE_LOCAL_LIMIT: usize = 4;
const HOSTILE_TARGET_RANGE: f64 = 16.0;
const ZOMBIE_ATTACK_RANGE: f64 = 0.8;
const ZOMBIE_ATTACK_DAMAGE: u8 = 3;
const ZOMBIE_ATTACK_INTERVAL: u8 = 20;
const ZOMBIE_KNOCKBACK_HORIZONTAL: f64 = 0.4;
const ZOMBIE_KNOCKBACK_VERTICAL: f64 = 0.36;
const SUNLIGHT_DAMAGE: u8 = 2;
const SUNLIGHT_INTERVAL: u8 = 20;
const CREEPER_IGNITE_RANGE: f64 = 3.0;
const CREEPER_FUSE_LIMIT: u8 = 30;
const EXPLOSION_BLOCK_RADIUS: f64 = 3.0;
const EXPLOSION_HURT_RADIUS: f64 = 6.0;
const EXPLOSION_DAMAGE: f64 = 15.0;
const PLAYER_BODY_CENTER: f64 = 0.9;
/// Added before walking prediction halves horizontal velocity.
/// Grounded prediction also caps the vertical result at 0.4.
const EXPLOSION_PUSH_HORIZONTAL: f64 = 1.0;
const EXPLOSION_PUSH_VERTICAL: f64 = 0.5;
const EXPLOSION_DROP_SALT: u64 = 25;
const EXPLOSION_TOUGH_DIG_TICKS: u16 = 250;

/// Horizontal unit from the zombie's feet to the player's feet, scaled to the
/// knockback speed. A zero horizontal distance leaves only the upward component.
/// Arithmetic is limited to addition, subtraction, multiplication, division and sqrt.
fn zombie_knockback(from: [f64; 3], to: [f64; 3]) -> [f64; 3] {
    let dx = to[0] - from[0];
    let dz = to[2] - from[2];
    let horizontal = (dx * dx + dz * dz).sqrt();
    if horizontal == 0.0 {
        [0.0, ZOMBIE_KNOCKBACK_VERTICAL, 0.0]
    } else {
        [
            dx / horizontal * ZOMBIE_KNOCKBACK_HORIZONTAL,
            ZOMBIE_KNOCKBACK_VERTICAL,
            dz / horizontal * ZOMBIE_KNOCKBACK_HORIZONTAL,
        ]
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Hostile {
    attack_ticks: u8,
    sunlight_ticks: u8,
    shot_ticks: Option<u8>,
    fuse: Option<u8>,
}

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
    egg_knockback: bool,
    pub(super) wool_color: WoolColor,
    pub(super) wool_ticks: u16,
    hostile: Option<Hostile>,
    /// Visual flame. Derived each tick from sunlight and lava, so it is not hashed or saved.
    burning: bool,
}

impl Mob {
    pub(crate) fn new(kind: MobKind, pos: [f64; 3]) -> Self {
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
            egg_knockback: false,
            wool_color: WoolColor::White,
            wool_ticks: 0,
            hostile: spec.chase_forward.map(|_| Hostile {
                shot_ticks: (kind == MobKind::Skeleton).then_some(SKELETON_INITIAL_SHOT_TICKS),
                fuse: (kind == MobKind::Creeper).then_some(0),
                ..Hostile::default()
            }),
            burning: false,
        }
    }

    pub fn pos(&self) -> [f64; 3] {
        self.body.position
    }

    pub(crate) fn chunk(&self) -> (i32, i32) {
        let [x, _, z] = self.pos().map(|v| v.floor() as i32);
        (x >> 4, z >> 4)
    }

    pub(super) fn is_animal(&self) -> bool {
        self.hostile.is_none()
    }

    pub(super) fn velocity(&self) -> [f64; 3] {
        self.body.velocity
    }

    pub(super) fn write_saved(&self, w: &mut world::io::Writer) {
        w.u8(self.kind.wire_id());
        for value in self.pos().into_iter().chain(self.velocity()) {
            w.f64(value);
        }
        w.f32(self.yaw);
        w.u8(self.health);
        w.i32(self.age as i32);
        w.u8(u8::from(self.body.on_ground));
        w.u16(self.egg_ticks.unwrap_or(0));
        if self.kind == MobKind::Sheep {
            w.u8(self.wool_color as u8);
            w.u16(self.wool_ticks);
        }
    }

    pub(super) fn read_saved(
        chunk: crate::ChunkPos,
        r: &mut world::io::Reader,
        has_wool: bool,
    ) -> Result<Self, world::io::DecodeError> {
        use crate::entity_storage::read_motion;
        use world::io::DecodeError;

        let kind = match r.u8()? {
            0 => MobKind::Cow,
            1 => MobKind::Pig,
            2 => MobKind::Chicken,
            3 => MobKind::Sheep,
            _ => return Err(DecodeError),
        };
        let (pos, velocity) = read_motion(chunk, r)?;
        let mut mob = Self::new(kind, pos);
        let yaw = r.f32()?;
        let health = r.u8()?;
        let age = r.i32()? as u32;
        let on_ground = match r.u8()? {
            0 => false,
            1 => true,
            _ => return Err(DecodeError),
        };
        let egg_ticks = match (kind, r.u16()?) {
            (MobKind::Chicken, ticks @ 1..=12000) => Some(ticks),
            (kind, 0) if kind != MobKind::Chicken => None,
            _ => return Err(DecodeError),
        };
        if !yaw.is_finite() || health == 0 || health > mob.health {
            return Err(DecodeError);
        }
        mob.body.velocity = velocity;
        mob.body.on_ground = on_ground;
        mob.yaw = yaw;
        mob.health = health;
        mob.age = age;
        mob.fall_start_y = Some(pos[1]);
        mob.egg_ticks = egg_ticks;
        if has_wool {
            if kind != MobKind::Sheep {
                return Err(DecodeError);
            }
            mob.wool_color = WoolColor::from_wire_id(r.u8()?)?;
            mob.wool_ticks = r.u16()?;
            if mob.wool_ticks > WOOL_REGROW_TICKS {
                return Err(DecodeError);
            }
        }
        Ok(mob)
    }

    pub(crate) fn bounds(&self) -> physics::Aabb {
        self.body.bounds()
    }

    fn sheared(&self) -> bool {
        self.wool_ticks != 0
    }

    fn sheep_appearance(&self, id: u32) -> S2C {
        S2C::SheepAppearance {
            id,
            color: self.wool_color,
            sheared: self.sheared(),
        }
    }

    fn wool_item(&self) -> u16 {
        let block = match self.wool_color {
            WoolColor::White => blocks::WHITE_WOOL,
            WoolColor::Gray => blocks::GRAY_WOOL,
            WoolColor::Brown => blocks::BROWN_WOOL,
            WoolColor::Black => blocks::BLACK_WOOL,
        };
        items::for_block(block).unwrap()
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
        self.hurt_with_knockback(world, damage, ([dx, dz], !same_position), seed, id, time);
    }

    pub(crate) fn hurt_with_knockback(
        &mut self,
        world: &World,
        damage: u8,
        ([dx, dz], flee_along_hit): ([f64; 2], bool),
        seed: i64,
        id: u32,
        time: i64,
    ) {
        if !self.take_damage(damage) || self.health == 0 {
            return;
        }

        // Scale the components first so that very small offsets do not underflow.
        let largest = dx.abs().max(dz.abs());
        let (dx, dz) = if largest == 0.0 {
            (0.0, 0.0)
        } else {
            (dx / largest, dz / largest)
        };
        let length = (dx * dx + dz * dz).sqrt().max(1.0);
        if self.hostile.is_none() {
            let away = (flee_along_hit && largest != 0.0).then(|| [dx / length, dz / length]);
            self.start_fleeing(seed, id, time, away);
        }

        let scale = 0.4 / length;
        self.body.velocity[0] = dx * scale;
        self.body.velocity[2] = dz * scale;
        if self.body.is_grounded(&mob_collisions(world)) {
            self.body.velocity[1] = 0.36;
        }
    }

    pub(super) fn hit_by_egg(&mut self, [x, _, z]: [f64; 3], seed: i64, id: u32, time: i64) {
        let length = (x * x + z * z).sqrt();
        let away = (length > 0.0).then(|| [x / length, z / length]);
        let [x, z] = away.unwrap_or([0.0; 2]);
        self.body.velocity = [x * 0.3, 0.2, z * 0.3];
        self.egg_knockback = true;
        if self.is_animal() {
            self.start_fleeing(seed, id, time, away);
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

    fn fuse_ticks(&self) -> Option<u8> {
        self.hostile.as_ref().and_then(|hostile| hostile.fuse)
    }

    /// Ignite while a target is close and visible. Otherwise a lit fuse cools down.
    /// The returned flag means this tick the creeper stops and faces the target.
    fn advance_fuse(&mut self, world: &World, chase: Option<[f64; 3]>) -> bool {
        let Some(fuse) = self.fuse_ticks() else {
            return false;
        };
        let ignite = chase.is_some_and(|target| {
            spatial_distance(self.pos(), target) <= CREEPER_IGNITE_RANGE
                && self.sees_player(world, target)
        });
        self.hostile.as_mut().unwrap().fuse = Some(if ignite {
            fuse + 1
        } else {
            fuse.saturating_sub(1)
        });
        ignite
    }

    fn sees_player(&self, world: &World, target: [f64; 3]) -> bool {
        let [tx, ty, tz] = target;
        clear_sight(world, self.eye(), [tx, ty + physics::EYE_HEIGHT, tz])
    }

    fn face_hold(&mut self, chase: Option<[f64; 3]>) {
        if let Some([tx, _, tz]) = chase {
            let [x, _, z] = self.pos();
            if x != tx || z != tz {
                self.yaw = heading(tx - x, tz - z);
            }
        }
        self.stop_horizontal();
        self.ai = Wander::Idle;
    }

    fn tick(
        &mut self,
        world: &World,
        seed: i64,
        id: u32,
        time: i64,
        chase: Option<[f64; 3]>,
    ) -> Option<DeathCause> {
        if let Some(hostile) = &mut self.hostile {
            hostile.attack_ticks = hostile.attack_ticks.saturating_sub(1);
            if let Some(ticks) = &mut hostile.shot_ticks {
                *ticks = ticks.saturating_sub(1);
            }
        }
        let hold = self.advance_fuse(world, chase);
        self.age = self.age.saturating_add(1);
        if self.fuse_ticks() == Some(CREEPER_FUSE_LIMIT) {
            self.face_hold(chase);
            return None;
        }
        let before = self.pos();
        let turn = self.move_body(world, seed, id, time, chase, hold);
        if self.pos()[1] < VOID_Y {
            return None;
        }

        let damage = self.environment_damage(world, before);
        if damage.is_some() {
            if self.health != 0 && self.hostile.is_none() {
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

    fn sun_exposed(&self, world: &World, daytime: bool) -> bool {
        if !spec(self.kind).burns_in_sunlight || self.hostile.is_none() {
            return false;
        }
        let pos = self.pos();
        daytime
            && self.health != 0
            && pos[1] >= VOID_Y
            && sees_sunlight(world, pos, spec(self.kind).head_offset)
    }

    fn touches_lava(&self, world: &World) -> bool {
        let pos = self.pos();
        block_at(world, pos, spec(self.kind).head_offset).is_some_and(blocks::is_lava)
            || block_at(world, pos, LAVA_FEET_OFFSET).is_some_and(blocks::is_lava)
    }

    /// Same sunlight exposure as `sunlight_hit`, or the lava contact used for damage.
    fn burning_now(&self, world: &World, daytime: bool) -> bool {
        self.sun_exposed(world, daytime) || self.touches_lava(world)
    }

    fn sunlight_hit(&mut self, world: &World, daytime: bool) -> bool {
        let exposed = self.sun_exposed(world, daytime);
        let Some(hostile) = &mut self.hostile else {
            return false;
        };
        interval(&mut hostile.sunlight_ticks, exposed, SUNLIGHT_INTERVAL)
            && self.take_damage(SUNLIGHT_DAMAGE)
    }

    fn attacks(&mut self, target: [f64; 3]) -> bool {
        let bounds = self.body.bounds();
        let Some(hostile) = &mut self.hostile else {
            return false;
        };
        if hostile.attack_ticks != 0 || hostile.shot_ticks.is_some() || hostile.fuse.is_some() {
            return false;
        }
        let player = Player::new(target).bounds();
        let [dx, dy, dz] = std::array::from_fn(|axis| {
            (bounds.min[axis] - player.max[axis])
                .max(player.min[axis] - bounds.max[axis])
                .max(0.0)
        });
        if dx * dx + dy * dy + dz * dz > ZOMBIE_ATTACK_RANGE * ZOMBIE_ATTACK_RANGE {
            return false;
        }
        hostile.attack_ticks = ZOMBIE_ATTACK_INTERVAL;
        true
    }

    fn eye(&self) -> [f64; 3] {
        let [x, y, z] = self.pos();
        [x, y + spec(self.kind).head_offset, z]
    }

    fn shoot(&mut self, world: &World, mut target: [f64; 3]) -> Option<Arrow> {
        let origin = self.eye();
        let dy = target[1] - self.pos()[1];
        let ticks = self.hostile.as_mut()?.shot_ticks.as_mut()?;
        if *ticks != 0
            || distance_squared(origin, target) + dy * dy
                > HOSTILE_TARGET_RANGE * HOSTILE_TARGET_RANGE
        {
            return None;
        }
        target[1] += physics::EYE_HEIGHT;
        if !clear_sight(world, origin, target) {
            return None;
        }
        *ticks = SKELETON_SHOT_INTERVAL;
        Some(Arrow::aimed(origin, target))
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
    fn move_body(
        &mut self,
        world: &World,
        seed: i64,
        id: u32,
        time: i64,
        chase: Option<[f64; 3]>,
        hold: bool,
    ) -> bool {
        let before = self.pos();
        let [x, y, z] = before;
        let collisions = mob_collisions(world);
        let egg_knockback = std::mem::take(&mut self.egg_knockback);
        let mut input = Input {
            jump: !hold && !egg_knockback && physics::in_water(&collisions, before),
            ..Input::default()
        };
        let fleeing = matches!(self.ai, Wander::Fleeing { .. });
        let knockback = (fleeing || self.hostile.is_some()) && self.hurt_ticks == HURT_TICKS;
        let chasing = chase.is_some();
        if chasing {
            self.ai = Wander::Idle;
        } else if !knockback && !egg_knockback && self.ai == Wander::Idle {
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
        let movement = if egg_knockback {
            None
        } else if hold {
            self.face_hold(chase);
            None
        } else if knockback {
            None
        } else if let Some(target) = chase {
            let [tx, ty, tz] = target;
            if self.kind == MobKind::Skeleton
                && distance_squared(before, target) <= SKELETON_STOP_RANGE * SKELETON_STOP_RANGE
                && clear_sight(world, self.eye(), [tx, ty + physics::EYE_HEIGHT, tz])
            {
                if x != tx || z != tz {
                    self.yaw = heading(tx - x, tz - z);
                }
                self.stop_horizontal();
                None
            } else {
                spec.chase_forward.map(|forward| ([tx, tz], forward))
            }
        } else {
            match self.ai {
                Wander::Walking { target, .. } => Some((target, spec.walk_forward)),
                Wander::Fleeing { target, .. } => Some((target, spec.flee_forward)),
                Wander::Idle => None,
            }
        };
        let mut turn = false;
        let mut step_jump = false;
        if let Some((target, forward)) = movement {
            let dx = target[0] - x;
            let dz = target[1] - z;
            let distance_squared = dx * dx + dz * dz;
            let stop_distance = if chasing { 0.0 } else { STOP_DISTANCE_SQUARED };
            if chasing && distance_squared > 0.0 {
                self.yaw = heading(dx, dz);
            }
            let jump = if distance_squared <= stop_distance {
                None
            } else {
                let scale = PROBE_DISTANCE / distance_squared.sqrt();
                let ahead = [x + dx * scale, y, z + dz * scale];
                safe_ahead(world, &collisions, spec, before, ahead)
            };
            if let Some(jump) = jump {
                if !chasing {
                    self.yaw = heading(dx, dz);
                }
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
        if self.kind == MobKind::Sheep {
            h.u8(self.wool_color as u8);
            h.u8(u8::from(self.sheared()));
            h.bytes(&self.wool_ticks.to_be_bytes());
        }
        if let Some(egg_ticks) = self.egg_ticks {
            h.bytes(&egg_ticks.to_be_bytes());
        }
        if self.egg_knockback {
            h.bytes(b"egg_knockback");
        }
        if let Some(hostile) = &self.hostile {
            h.u8(hostile.attack_ticks);
            h.u8(hostile.sunlight_ticks);
            if let Some(ticks) = hostile.shot_ticks {
                h.u8(ticks);
            }
            if let Some(fuse) = hostile.fuse {
                h.u8(fuse);
            }
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

fn sees_sunlight(world: &World, pos: [f64; 3], head_offset: f64) -> bool {
    let collisions = mob_collisions(world);
    if physics::in_water(&collisions, pos)
        || block_at(world, pos, head_offset).is_some_and(blocks::is_water)
    {
        return false;
    }
    let head_y = pos[1] + head_offset;
    let [x, y, z] = [pos[0], head_y, pos[2]].map(|v| v.floor() as i32);
    let Some(chunk) = world.chunks.get(&(x >> 4, z >> 4)) else {
        return false;
    };
    (y.max(MIN_Y)..MIN_Y + HEIGHT).all(|by| {
        let state = chunk.get((x & 15) as usize, by, (z & 15) as usize);
        if blocks::is_water(state) {
            return false;
        }
        let mut blocked = false;
        if blocks::is_solid(state) {
            collisions.collision_boxes(x, by, z, &mut |bounds| {
                blocked |= by > y || bounds.min[1] >= head_y;
            });
        }
        !blocked
    })
}

fn has_loot_support(world: &World, collisions: &impl CollisionWorld, [x, y, z]: [f64; 3]) -> bool {
    let [bx, by, bz] = [x, y - 0.01, z].map(|v| v.floor() as i32);
    // The mob's footprint can stay grounded while its center is over an edge.
    // Fences can support the center from a block below the cell under the feet.
    [by, by - 1].into_iter().any(|block_y| {
        if world.get_block(bx, block_y, bz).is_none_or(blocks::is_lava) {
            return false;
        }
        let mut supported = false;
        collisions.collision_boxes(bx, block_y, bz, &mut |bounds| {
            supported |= bounds.max[1] > f64::from(by)
                && bounds.max[1] <= y
                && (bounds.min[0]..bounds.max[0]).contains(&x)
                && (bounds.min[2]..bounds.max[2]).contains(&z);
        });
        supported
    })
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
pub(super) fn sample(seed: i64, id: u32, time: i64, salt: u64) -> u64 {
    let mut bits = (seed as u64)
        ^ u64::from(id).wrapping_mul(0xd1b5_4a32_d192_ed03)
        ^ (time as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ salt.wrapping_mul(0x94d0_49bb_1331_11eb);
    bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    bits ^ (bits >> 31)
}

fn hostile_kind(seed: i64, player: u32, time: i64) -> MobKind {
    match sample(seed, player, time, HOSTILE_KIND_SALT) % 3 {
        0 => MobKind::Zombie,
        1 => MobKind::Skeleton,
        _ => MobKind::Creeper,
    }
}

fn hostile_dark_kind(seed: i64, player: u32, time: i64) -> MobKind {
    match sample(seed, player, time, HOSTILE_DARK_KIND_SALT) % 3 {
        0 => MobKind::Zombie,
        1 => MobKind::Skeleton,
        _ => MobKind::Creeper,
    }
}

fn spatial_distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

fn blast_damage(distance: f64, exposure: f64) -> u8 {
    if distance >= EXPLOSION_HURT_RADIUS || exposure == 0.0 {
        return 0;
    }
    (EXPLOSION_DAMAGE * (EXPLOSION_HURT_RADIUS - distance) / EXPLOSION_HURT_RADIUS * exposure)
        .floor() as u8
}

fn bounds_center(bounds: physics::Aabb) -> [f64; 3] {
    std::array::from_fn(|axis| (bounds.min[axis] + bounds.max[axis]) * 0.5)
}

/// Fraction of the 3×3×3 hitbox lattice that can see `center` through full cubes.
fn blast_exposure(world: &World, center: [f64; 3], bounds: physics::Aabb) -> f64 {
    let mut clear = 0;
    for step_y in 0..3 {
        for step_z in 0..3 {
            for step_x in 0..3 {
                let steps = [step_x, step_y, step_z];
                let point = std::array::from_fn(|axis| {
                    bounds.min[axis]
                        + (bounds.max[axis] - bounds.min[axis]) * (steps[axis] as f64 * 0.5)
                });
                if !full_cube_occludes(world, point, center) {
                    clear += 1;
                }
            }
        }
    }
    clear as f64 / 27.0
}

fn cell_is_full_cube(world: &World, x: i32, y: i32, z: i32) -> bool {
    let mut full = false;
    BlockWorld(|bx, by, bz| world.get_block(bx, by, bz)).collision_boxes(x, y, z, &mut |bounds| {
        full |= bounds == physics::Aabb::block(x, y, z);
    });
    full
}

/// Positive-length overlap of the segment `start + t * delta`, `t` in [0, 1], with `bounds`.
/// Touching a face without entering the interior does not count.
fn segment_overlaps_aabb(start: [f64; 3], delta: [f64; 3], bounds: physics::Aabb) -> bool {
    let mut tmin = 0.0;
    let mut tmax = 1.0;
    for axis in 0..3 {
        let min = bounds.min[axis];
        let max = bounds.max[axis];
        if delta[axis] == 0.0 {
            if start[axis] <= min || start[axis] >= max {
                return false;
            }
            continue;
        }
        let inv = 1.0 / delta[axis];
        let (mut near, mut far) = ((min - start[axis]) * inv, (max - start[axis]) * inv);
        if near > far {
            std::mem::swap(&mut near, &mut far);
        }
        if near > tmin {
            tmin = near;
        }
        if far < tmax {
            tmax = far;
        }
        if tmin >= tmax {
            return false;
        }
    }
    true
}

/// Same cell walk as arrow block tracing. Only solid full-cell cubes occlude;
/// fluids, air and partial or empty shapes do not.
fn full_cube_occludes(world: &World, start: [f64; 3], end: [f64; 3]) -> bool {
    let delta = std::array::from_fn(|axis| end[axis] - start[axis]);
    let mut cell = start.map(|value| value.floor() as i32);
    let goal = end.map(|value| value.floor() as i32);
    // The walk uses the upper cell on each stationary integer plane. Include the
    // lower neighbor across each such plane: the seam is interior to the solid
    // only when both face neighbors (or all four cells around an edge) are full.
    let seam: [i32; 3] = std::array::from_fn(|axis| {
        i32::from(start != end && delta[axis] == 0.0 && start[axis] == f64::from(cell[axis]))
    });
    let step: [i32; 3] = std::array::from_fn(|axis| if goal[axis] > cell[axis] { 1 } else { -1 });
    loop {
        let [x, y, z] = cell;
        if !world.chunks.contains_key(&(x >> 4, z >> 4)) {
            return true;
        }
        let [min_x, min_y, min_z] = std::array::from_fn(|axis| cell[axis] - seam[axis]);
        let solid = (min_x..=x).all(|bx| {
            (min_y..=y).all(|by| (min_z..=z).all(|bz| cell_is_full_cube(world, bx, by, bz)))
        });
        if solid {
            let mut bounds = physics::Aabb::block(x, y, z);
            bounds.min = [min_x, min_y, min_z].map(f64::from);
            if segment_overlaps_aabb(start, delta, bounds) {
                return true;
            }
        }
        if cell == goal {
            return false;
        }
        let mut best = 0.0;
        let mut chosen = [false; 3];
        let mut any = false;
        for axis in 0..3 {
            if cell[axis] == goal[axis] {
                continue;
            }
            let boundary = f64::from(cell[axis]) + f64::from(step[axis] > 0);
            let crossing = (boundary - start[axis]) / delta[axis];
            if !any || crossing < best {
                best = crossing;
                chosen = [false; 3];
                chosen[axis] = true;
                any = true;
            } else if crossing == best {
                chosen[axis] = true;
            }
        }
        if !any {
            return false;
        }
        for axis in 0..3 {
            if chosen[axis] {
                cell[axis] += step[axis];
            }
        }
    }
}

fn explosion_velocity(center: [f64; 3], body: [f64; 3], distance: f64, exposure: f64) -> [f64; 3] {
    let impact = (1.0 - distance / EXPLOSION_HURT_RADIUS) * exposure;
    if distance == 0.0 {
        return [0.0, impact * EXPLOSION_PUSH_VERTICAL, 0.0];
    }
    let horizontal = impact * EXPLOSION_PUSH_HORIZONTAL / distance;
    let vertical = impact * EXPLOSION_PUSH_VERTICAL / distance;
    [
        (body[0] - center[0]) * horizontal,
        (body[1] - center[1]) * vertical,
        (body[2] - center[2]) * horizontal,
    ]
}

fn explosion_spares(state: u16) -> bool {
    if state == blocks::AIR || blocks::is_fluid(state) {
        return true;
    }
    match blocks::info(state).dig_ticks {
        None => true,
        Some(ticks) => ticks >= EXPLOSION_TOUGH_DIG_TICKS,
    }
}

fn explosion_drops(seed: i64, time: i64, [x, y, z]: [i32; 3]) -> bool {
    let bits = (seed as u64)
        ^ (time as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ (x as u32 as u64).wrapping_mul(0xd1b5_4a32_d192_ed03)
        ^ (y as u32 as u64).wrapping_mul(0xbf58_476d_1ce4_e5b9)
        ^ (z as u32 as u64).wrapping_mul(0x94d0_49bb_1331_11eb)
        ^ EXPLOSION_DROP_SALT.wrapping_mul(0x94d0_49bb_1331_11eb);
    jmath::mix_stafford13(bits).is_multiple_of(3)
}

fn block_center_range(center: f64) -> RangeInclusive<i32> {
    let min = (center - EXPLOSION_BLOCK_RADIUS - 0.5).floor() as i32;
    let max = (center + EXPLOSION_BLOCK_RADIUS - 0.5).floor() as i32;
    min..=max
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

fn hostile_surface(world: &World, x: i32, z: i32) -> Option<[f64; 3]> {
    let chunk = world.chunks.get(&(x >> 4, z >> 4))?;
    let get = |y| chunk.get((x & 15) as usize, y, (z & 15) as usize);
    // Reaching a fluid before the ground means the column is covered.
    let ground = (MIN_Y..MIN_Y + HEIGHT).rev().find(|&y| {
        let state = get(y);
        blocks::is_solid(state) || blocks::is_fluid(state)
    })?;
    let state = get(ground);
    if blocks::is_oak_leaves(state)
        || blocks::is_fluid(state)
        || get(ground + 1) != blocks::AIR
        || get(ground + 2) != blocks::AIR
    {
        return None;
    }
    let mut full = false;
    mob_collisions(world).collision_boxes(x, ground, z, &mut |bounds| {
        full |= bounds == physics::Aabb::block(x, ground, z);
    });
    full.then_some([
        f64::from(x) + 0.5,
        f64::from(ground + 1),
        f64::from(z) + 0.5,
    ])
}

fn hostile_dark_feet(world: &World, x: i32, z: i32, start_y: i32) -> Option<[f64; 3]> {
    let chunk = world.chunks.get(&(x >> 4, z >> 4))?;
    let top = MIN_Y + HEIGHT - 1;
    let get = |y: i32| chunk.get((x & 15) as usize, y, (z & 15) as usize);
    for step in 0..HOSTILE_DARK_DESCENT {
        let solid_y = start_y - step;
        if solid_y < MIN_Y {
            break;
        }
        if solid_y > top {
            continue;
        }
        let state = get(solid_y);
        if !blocks::is_solid(state) || blocks::is_oak_leaves(state) || blocks::is_fluid(state) {
            continue;
        }
        if solid_y + 2 > top || get(solid_y + 1) != blocks::AIR || get(solid_y + 2) != blocks::AIR {
            continue;
        }
        let mut full = false;
        mob_collisions(world).collision_boxes(x, solid_y, z, &mut |bounds| {
            full |= bounds == physics::Aabb::block(x, solid_y, z);
        });
        if !full {
            continue;
        }
        return Some([
            f64::from(x) + 0.5,
            f64::from(solid_y + 1),
            f64::from(z) + 0.5,
        ]);
    }
    None
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

    fn spawn_mob_drop(&mut self, item: u16, count: u8, [x, y, z]: [f64; 3], height: f64) {
        self.spawn_item(item, count, [x, y + height / 2.0, z], [0.0, 0.1, 0.0], 10);
    }

    pub(super) fn use_entity(&mut self, player: u32, id: u32) {
        let Some(mob) = self.mob_in_reach(player, id) else {
            return;
        };
        if mob.kind != MobKind::Sheep
            || mob.sheared()
            || self.clients[&player]
                .inventory
                .selected_stack()
                .is_none_or(|stack| items::info(stack.item).unwrap().name != "shears")
            || self.remaining_entity_ids() == 0
        {
            return;
        }

        let item = mob.wool_item();
        let pos = mob.pos();
        let chunk = mob.chunk();
        let count = 1 + (sample(self.seed, id, self.game_time, SHEAR_LOOT_SALT) % 3) as u8;
        self.spawn_mob_drop(item, count, pos, spec(MobKind::Sheep).height);
        self.mobs.get_mut(&id).unwrap().wool_ticks = WOOL_REGROW_TICKS;
        self.dirty_entity_chunk(chunk);
        self.send_sheep_appearance(id);
        self.outbox.push((player, S2C::Shear.encode()));
        self.wear_held_item(player);
    }

    pub(crate) fn drop_mob_loot(&mut self, id: u32, mob: Mob, burned: bool) {
        if mob.is_animal() {
            self.dirty_entity_chunk(mob.chunk());
        }
        let spec = spec(mob.kind);
        let pos = if burned { mob.last_dry_pos } else { mob.pos() };
        for (index, &(item, min, max)) in spec.loot.iter().enumerate() {
            let item = if mob.kind == MobKind::Sheep && Some(item) == items::by_name("white_wool") {
                if mob.sheared() {
                    continue;
                }
                mob.wool_item()
            } else {
                item
            };
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
                self.spawn_mob_drop(item, stack, pos, spec.height);
                count -= stack;
            }
        }
    }

    pub(super) fn spawn_mob(&mut self, kind: MobKind, pos: [f64; 3]) {
        if let Some(id) = self.allocate_entity_id() {
            let mut mob = Mob::new(kind, pos);
            if kind == MobKind::Chicken {
                mob.egg_ticks = Some(egg_interval(self.seed, id, self.game_time));
            } else if kind == MobKind::Sheep {
                mob.wool_color = match sample(self.seed, id, self.game_time, WOOL_COLOR_SALT) % 100
                {
                    0..=69 => WoolColor::White,
                    70..=84 => WoolColor::Gray,
                    85..=94 => WoolColor::Brown,
                    _ => WoolColor::Black,
                };
            }
            if mob.is_animal() {
                self.dirty_entity_chunk(mob.chunk());
            }
            self.mobs.insert(id, mob);
        }
    }

    #[cfg(test)]
    pub(super) fn spawn_cow(&mut self, pos: [f64; 3]) {
        self.spawn_mob(MobKind::Cow, pos);
    }

    fn nearby_animal_count(&self, pos: [f64; 3]) -> usize {
        self.mobs
            .values()
            .filter(|mob| mob.is_animal() && distance_squared(mob.pos(), pos) <= 64.0 * 64.0)
            .count()
    }

    pub(super) fn hatch_chicken(&mut self, pos: [f64; 3]) {
        let chicken = Mob::new(MobKind::Chicken, pos);
        let bounds = chicken.bounds();
        if !chicken.body.is_clear(&mob_collisions(&self.world))
            || self
                .mobs
                .values()
                .any(|mob| mob.health != 0 && mob.bounds().intersects(bounds))
            || self.clients.values().any(|client| {
                client.joined
                    && !client.health.vitals.dead
                    && Player::new(client.pos).bounds().intersects(bounds)
            })
        {
            return;
        }

        let mut near_player = false;
        for client in self.clients.values().filter(|client| {
            client.joined
                && !client.health.vitals.dead
                && distance_squared(client.pos, pos) <= 64.0 * 64.0
        }) {
            near_player = true;
            if self.nearby_animal_count(client.pos) >= LOCAL_LIMIT {
                return;
            }
        }
        if near_player || self.nearby_animal_count(pos) < LOCAL_LIMIT {
            self.spawn_mob(MobKind::Chicken, pos);
        }
    }

    fn spawn_herd(&mut self, id: u32, pos: [f64; 3], players: &[(u32, [f64; 3])]) {
        let nearby = self.nearby_animal_count(pos);
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

    fn spawn_hostile(&mut self, id: u32, pos: [f64; 3], players: &[(u32, [f64; 3])]) {
        let nearby = self
            .mobs
            .values()
            .filter(|mob| mob.hostile.is_some() && distance_squared(mob.pos(), pos) <= 64.0 * 64.0);
        if nearby.take(HOSTILE_LOCAL_LIMIT).count() == HOSTILE_LOCAL_LIMIT {
            return;
        }
        let roll = sample(self.seed, id, self.game_time, HOSTILE_COLUMN_SALT);
        let [dx, dz] = direction(roll);
        // Allow for rounding to the center of the sampled column.
        let radius = 24.75 + ((roll >> 16) % 2251) as f64 / 100.0;
        let x = (pos[0] + dx * radius).floor() as i32;
        let z = (pos[2] + dz * radius).floor() as i32;
        let Some(candidate) = hostile_surface(&self.world, x, z) else {
            return;
        };
        if !(24.0 * 24.0..=48.0 * 48.0).contains(&distance_squared(pos, candidate))
            || players
                .iter()
                .any(|&(other, p)| other != id && distance_squared(p, candidate) <= 24.0 * 24.0)
        {
            return;
        }
        if self.world.local_block_light([x, candidate[1] as i32, z]) > 0 {
            return;
        }
        self.spawn_mob(hostile_kind(self.seed, id, self.game_time), candidate);
    }

    fn spawn_hostile_dark(&mut self, id: u32, pos: [f64; 3], players: &[(u32, [f64; 3])]) {
        let nearby = self
            .mobs
            .values()
            .filter(|mob| mob.hostile.is_some() && distance_squared(mob.pos(), pos) <= 64.0 * 64.0);
        if nearby.take(HOSTILE_LOCAL_LIMIT).count() == HOSTILE_LOCAL_LIMIT {
            return;
        }
        let roll = sample(self.seed, id, self.game_time, HOSTILE_DARK_COLUMN_SALT);
        let [dx, dz] = direction(roll);
        // Same ring as the night surface attempt, from a separate salt.
        let radius = 24.75 + ((roll >> 16) % 2251) as f64 / 100.0;
        let x = (pos[0] + dx * radius).floor() as i32;
        let z = (pos[2] + dz * radius).floor() as i32;
        let feet_y = pos[1].floor() as i32;
        let start_y = feet_y + ((roll >> 32) % 33) as i32 - 16;
        let Some(candidate) = hostile_dark_feet(&self.world, x, z, start_y) else {
            return;
        };
        if !(24.0 * 24.0..=48.0 * 48.0).contains(&distance_squared(pos, candidate))
            || players
                .iter()
                .any(|&(other, p)| other != id && distance_squared(p, candidate) <= 24.0 * 24.0)
        {
            return;
        }
        let feet = [x, candidate[1] as i32, z];
        if self.world.local_sky_light(feet) != 0 || self.world.local_block_light(feet) != 0 {
            return;
        }
        self.spawn_mob(hostile_dark_kind(self.seed, id, self.game_time), candidate);
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
        let day = self.day_time.rem_euclid(24000);
        if (13000..23000).contains(&day) && self.game_time % HOSTILE_SPAWN_INTERVAL == 0 {
            for &(id, pos) in &players {
                self.spawn_hostile(id, pos, &players);
            }
        }
        if self.game_time % HOSTILE_SPAWN_INTERVAL == 0 {
            for &(id, pos) in &players {
                self.spawn_hostile_dark(id, pos, &players);
            }
        }
        let mut hits = Vec::new();
        let mut player_deaths = Vec::new();
        let mut shots = Vec::new();
        let mut fuse_updates = Vec::new();
        let mut explosions = Vec::new();
        let mut changed = Vec::new();
        let mut knockbacks = Vec::new();
        let mut burning_updates = Vec::new();
        let mut wool_updates = Vec::new();
        let daytime = day < 12000;
        for (&id, mob) in &mut self.mobs {
            let from = mob.chunk();
            if !self.world.chunks.contains_key(&from) || mob.pos()[1] < VOID_Y {
                continue;
            }
            if mob.sheared() {
                mob.wool_ticks -= 1;
                if !mob.sheared() {
                    wool_updates.push(id);
                }
            }
            let target = if mob.hostile.is_some() && self.game_mode == GameMode::Survival {
                let pos = mob.pos();
                self.clients
                    .iter()
                    .filter(|(_, client)| client.joined && !client.health.vitals.dead)
                    .filter_map(|(&id, client)| {
                        let dy = pos[1] - client.pos[1];
                        let distance = distance_squared(pos, client.pos) + dy * dy;
                        (distance <= HOSTILE_TARGET_RANGE * HOSTILE_TARGET_RANGE)
                            .then_some((distance, id, client.pos))
                    })
                    .min_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)))
                    .map(|(_, id, pos)| (id, pos))
            } else {
                None
            };
            let before = mob.pos();
            let before_fuse = mob.fuse_ticks();
            let damage = mob.tick(
                &self.world,
                self.seed,
                id,
                self.game_time,
                target.map(|(_, pos)| pos),
            );
            // Outside the build height, the collision world has no chunk walls.
            if mob.is_animal() && !self.world.chunks.contains_key(&mob.chunk()) {
                for axis in [0, 2] {
                    mob.body.position[axis] = before[axis];
                    mob.body.velocity[axis] = 0.0;
                }
            }
            let to = mob.chunk();
            if self.entity_persistence && mob.is_animal() && from != to {
                changed.extend([from, to]);
            }
            let after_fuse = mob.fuse_ticks();
            if before_fuse != after_fuse {
                if let Some(ticks) = after_fuse {
                    fuse_updates.push((id, ticks));
                }
            }
            if after_fuse == Some(CREEPER_FUSE_LIMIT) {
                explosions.push(id);
                continue;
            }
            let sunlight = mob.sunlight_hit(&self.world, daytime);
            if damage.is_some() || sunlight {
                hits.push((id, damage == Some(DeathCause::Lava)));
            }
            if mob.health != 0 && mob.pos()[1] >= VOID_Y {
                let burning = mob.burning_now(&self.world, daytime);
                if burning != mob.burning {
                    mob.burning = burning;
                    burning_updates.push((id, burning));
                }
            }
            if let Some((player, pos)) = target {
                if mob.health == 0 || mob.pos()[1] < VOID_Y {
                    continue;
                }
                if let Some(arrow) = mob.shoot(&self.world, pos) {
                    shots.push(arrow);
                } else if mob.attacks(pos) {
                    let velocity = zombie_knockback(mob.pos(), pos);
                    let health = &mut self.clients.get_mut(&player).unwrap().health;
                    health.damage(ZOMBIE_ATTACK_DAMAGE, DeathCause::Zombie);
                    if health.vitals.dead {
                        player_deaths.push(player);
                    } else {
                        knockbacks.push((player, velocity));
                    }
                }
            }
        }
        for arrow in shots {
            if let Some(id) = self.allocate_entity_id() {
                self.arrows.insert(id, arrow);
            }
        }
        for &(id, ticks) in &fuse_updates {
            self.send_mob_fuse(id, ticks);
        }
        for (player, velocity) in knockbacks {
            self.outbox
                .push((player, S2C::PlayerKnockback { velocity }.encode()));
        }
        for &(id, burning) in &burning_updates {
            if self.mobs.contains_key(&id) {
                self.send_mob_burning(id, burning);
            }
        }
        let blasts: Vec<[f64; 3]> = explosions
            .iter()
            .filter_map(|&id| {
                let mob = self.mobs.get(&id)?;
                let [x, y, z] = mob.pos();
                Some([x, y + spec(mob.kind).height / 2.0, z])
            })
            .collect();
        for id in &explosions {
            let _ = self.mobs.remove(id);
        }
        for center in blasts {
            let deaths = self.apply_explosion(center);
            player_deaths.extend(deaths);
        }
        for player in player_deaths {
            self.finish_player_death(player);
        }
        for (id, burned) in hits {
            let Some(health) = self.mobs.get(&id).map(|mob| mob.health) else {
                continue;
            };
            if health == 0 {
                let mob = self.mobs.remove(&id).unwrap();
                self.drop_mob_loot(id, mob, burned);
            } else {
                self.send_mob_hurt(id);
            }
        }
        for id in wool_updates {
            if let Some(mob) = self.mobs.get(&id) {
                self.dirty_entity_chunk(mob.chunk());
                self.send_sheep_appearance(id);
            }
        }
        let mut eggs = Vec::new();
        self.mobs.retain(|&id, mob| {
            let stays = mob.pos()[1] >= VOID_Y
                && self.world.chunks.contains_key(&mob.chunk())
                && (mob.is_animal()
                    || players
                        .iter()
                        .any(|&(_, pos)| distance_squared(mob.pos(), pos) <= 128.0 * 128.0));
            if let Some(ticks) = mob.egg_ticks.as_mut().filter(|_| stays && mob.health != 0) {
                *ticks -= 1;
                if *ticks == 0 {
                    *ticks = egg_interval(self.seed, id, self.game_time);
                    eggs.push(mob.pos());
                }
            }
            if self.entity_persistence && mob.is_animal() && !stays {
                changed.push(mob.chunk());
            }
            stays
        });
        for chunk in changed {
            self.dirty_entity_chunk(chunk);
        }
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
                if matches!(packet, S2C::MobSpawn { .. }) {
                    if let Some(ticks) = self.mobs[&id].fuse_ticks().filter(|ticks| *ticks > 0) {
                        self.outbox
                            .push((client, S2C::MobFuse { id, ticks }.encode()));
                    }
                    if self.mobs[&id].kind == MobKind::Sheep {
                        self.outbox
                            .push((client, self.mobs[&id].sheep_appearance(id).encode()));
                    }
                    if self.mobs[&id].burning {
                        self.outbox
                            .push((client, S2C::MobBurning { id, burning: true }.encode()));
                    }
                }
            }
            c.visible_mobs = visible;
        }
    }

    fn send_mob_fuse(&mut self, id: u32, ticks: u8) {
        let packet = S2C::MobFuse { id, ticks }.encode();
        for (&viewer, client) in &self.clients {
            if client.visible_mobs.contains_key(&id) {
                self.outbox.push((viewer, packet.clone()));
            }
        }
    }

    fn send_sheep_appearance(&mut self, id: u32) {
        let packet = self.mobs[&id].sheep_appearance(id).encode();
        for (&viewer, client) in &self.clients {
            if client.joined && client.visible_mobs.contains_key(&id) {
                self.outbox.push((viewer, packet.clone()));
            }
        }
    }

    fn send_mob_burning(&mut self, id: u32, burning: bool) {
        let packet = S2C::MobBurning { id, burning }.encode();
        for (&viewer, client) in &self.clients {
            if client.joined && client.visible_mobs.contains_key(&id) {
                self.outbox.push((viewer, packet.clone()));
            }
        }
    }

    fn send_explosion(&mut self, center: [f64; 3]) {
        let chunk = (
            (center[0].floor() as i32) >> 4,
            (center[2].floor() as i32) >> 4,
        );
        let packet = S2C::Explosion { center }.encode();
        for (&id, client) in &self.clients {
            if client.joined && client.sent.contains(&chunk) {
                self.outbox.push((id, packet.clone()));
            }
        }
    }

    fn apply_explosion(&mut self, center: [f64; 3]) -> Vec<u32> {
        let existing_items: Vec<_> = self.entities.keys().copied().collect();
        self.send_explosion(center);

        let mut deaths = Vec::new();
        if self.game_mode == GameMode::Survival {
            let players: Vec<_> = self
                .clients
                .iter()
                .filter(|(_, client)| client.joined && !client.health.vitals.dead)
                .map(|(&id, client)| {
                    let [x, y, z] = client.pos;
                    let body = [x, y + PLAYER_BODY_CENTER, z];
                    (id, body, physics::Player::new(client.pos).bounds())
                })
                .collect();
            for (id, body, bounds) in players {
                let distance = spatial_distance(center, body);
                if distance >= EXPLOSION_HURT_RADIUS {
                    continue;
                }
                let exposure = blast_exposure(&self.world, center, bounds);
                if exposure == 0.0 {
                    continue;
                }
                let damage = blast_damage(distance, exposure);
                let dead = {
                    let health = &mut self.clients.get_mut(&id).unwrap().health;
                    if damage != 0 {
                        health.damage(damage, DeathCause::Explosion);
                    }
                    health.vitals.dead
                };
                if dead {
                    deaths.push(id);
                } else {
                    let velocity = explosion_velocity(center, body, distance, exposure);
                    self.outbox
                        .push((id, S2C::PlayerKnockback { velocity }.encode()));
                }
            }
        }

        let victims: Vec<_> = self
            .mobs
            .iter()
            .filter_map(|(&id, mob)| {
                if mob.health == 0 || mob.hurt_ticks != 0 {
                    return None;
                }
                let bounds = mob.bounds();
                let body = [
                    mob.pos()[0],
                    mob.pos()[1] + spec(mob.kind).height / 2.0,
                    mob.pos()[2],
                ];
                let distance = spatial_distance(center, body);
                if distance >= EXPLOSION_HURT_RADIUS {
                    return None;
                }
                let damage = blast_damage(distance, blast_exposure(&self.world, center, bounds));
                (damage != 0).then_some((id, damage))
            })
            .collect();
        for (id, damage) in victims {
            let dead = {
                let Some(mob) = self.mobs.get_mut(&id) else {
                    continue;
                };
                mob.hurt(
                    &self.world,
                    damage,
                    (center, 0.0),
                    self.seed,
                    id,
                    self.game_time,
                );
                mob.health == 0
            };
            if dead {
                let mob = self.mobs.remove(&id).unwrap();
                self.drop_mob_loot(id, mob, false);
            } else {
                self.send_mob_hurt(id);
            }
        }

        let removed: Vec<_> = existing_items
            .into_iter()
            .filter_map(|id| {
                let entity = self.entities.get(&id)?;
                let bounds = entity.bounds();
                let distance = spatial_distance(center, bounds_center(bounds));
                if distance >= EXPLOSION_HURT_RADIUS {
                    return None;
                }
                (blast_exposure(&self.world, center, bounds) > 0.0).then_some((id, entity.chunk()))
            })
            .collect();
        for (id, chunk) in removed {
            self.entities.remove(&id);
            self.dirty_entity_chunk(chunk);
        }

        for y in block_center_range(center[1]) {
            for z in block_center_range(center[2]) {
                for x in block_center_range(center[0]) {
                    let block_center = [x as f64 + 0.5, y as f64 + 0.5, z as f64 + 0.5];
                    if spatial_distance(center, block_center) > EXPLOSION_BLOCK_RADIUS {
                        continue;
                    }
                    let Some(state) = self.world.get_block(x, y, z) else {
                        continue;
                    };
                    if explosion_spares(state) {
                        continue;
                    }
                    let drops = explosion_drops(self.seed, self.game_time, [x, y, z]);
                    self.break_exploded_block([x, y, z], drops);
                }
            }
        }
        deaths
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
        a.tick(&world, 5, 7, start - 1, None);
        b.tick(&world, 5, 7, start - 1, None);
        assert_eq!(a.ai, Wander::Idle);
        a.tick(&world, 5, 7, start, None);
        b.tick(&world, 5, 7, start, None);
        assert!(matches!(a.ai, Wander::Walking { .. }));
        let mut stopped = false;
        for t in start + 1..=start + 100 {
            a.tick(&world, 5, 7, t, None);
            b.tick(&world, 5, 7, t, None);
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
        cow.tick(&world, 5, 7, 1, None);
        assert_eq!(cow.ai, Wander::Idle);
        cow.ai = Wander::Walking {
            target: [2.5, 9.0],
            ticks_left: 1,
            blocked: 0,
        };
        cow.tick(&world, 5, 7, 2, None);
        assert!(cow.pos()[2] > 2.0);
        assert_eq!(cow.ai, Wander::Idle);

        world.set_block(2, 1, 3, blocks::STONE);
        world.set_block(2, 2, 3, blocks::STONE);
        let mut cow = walking();
        cow.body.position[2] = 3.0 - spec(MobKind::Cow).width / 2.0;
        cow.tick(&world, 5, 7, 1, None);
        assert!(matches!(cow.ai, Wander::Walking { blocked: 1, .. }));
        cow.tick(&world, 5, 7, 2, None);
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
                cow.tick(&world, 5, 7, t, None);
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
            cow.tick(&world, 5, 7, tick, None);
            assert_eq!(cow.pos()[2], 2.55);
            assert!(matches!(cow.ai, Wander::Walking { blocked: 0, .. }));
        }
        for tick in 3..=30 {
            cow.tick(&world, 5, 7, tick, None);
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

        cow.tick(&world, 5, 7, 1, None);
        assert!(
            matches!(cow.ai, Wander::Walking { blocked: 1, .. }),
            "{cow:?}"
        );
        cow.tick(&world, 5, 7, 2, None);
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
            cow.tick(&world, 5, 7, tick, None);
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
            cow.tick(&world, 5, 7, 1, None);
            assert_eq!(cow.pos()[1] > 1.0, can_jump, "{cow:?}");
            for tick in 2..=30 {
                cow.tick(&world, 5, 7, tick, None);
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
            cow.tick(&world, 5, 7, t, None);
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
            cow.tick(&pool, 5, 7, quiet, None);
        }
        let mut low = cow.pos()[1];
        let mut high = low;
        for _ in 0..60 {
            cow.tick(&pool, 5, 7, quiet, None);
            low = low.min(cow.pos()[1]);
            high = high.max(cow.pos()[1]);
        }
        assert!(low > 3.0 && low < 3.6, "{low}");
        assert!(high > 3.6 && high < 4.0, "{high}");
    }

    fn joined(mode: GameMode) -> Server {
        joined_with_seed(mode, 2026)
    }

    fn joined_with_seed(mode: GameMode, seed: i64) -> Server {
        let mut server = Server::new(seed, Generator::Flat);
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
                    damage: 0,
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
                        .set(
                            1,
                            Some(crate::Stack {
                                item,
                                count: 1,
                                damage: 0,
                            }),
                        )
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
    fn melee_wear_requires_a_landed_survival_hit() {
        for mode in [GameMode::Survival, GameMode::Creative] {
            let (mut server, id) = combat(mode);
            let item = items::by_name("wooden_axe").unwrap();
            let damage = items::info(item).unwrap().durability.unwrap() - 2;
            let stack = crate::Stack {
                item,
                count: 1,
                damage,
            };
            server
                .clients
                .get_mut(&1)
                .unwrap()
                .inventory
                .set(0, Some(stack))
                .unwrap();
            for attempt in 0..3 {
                if attempt == 2 {
                    server.mobs.get_mut(&id).unwrap().hurt_ticks = 0;
                }
                server.apply(1, C2S::Attack { id });
                assert_eq!(server.mobs[&id].health, if attempt == 2 { 4 } else { 7 });
                let broken = attempt == 2 && mode == GameMode::Survival;
                let worn = if mode == GameMode::Survival {
                    damage + 1
                } else {
                    damage
                };
                assert_eq!(
                    server.clients[&1].inventory.selected_stack(),
                    (!broken).then_some(crate::Stack {
                        damage: worn,
                        ..stack
                    })
                );
                assert_eq!(
                    server.take_outbox().contains(&(1, S2C::ToolBreak.encode())),
                    broken
                );
            }
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

    #[test]
    fn an_egg_hit_starts_sixty_ticks_of_fleeing_even_during_damage_immunity() {
        let mut cow = Mob::new(MobKind::Cow, [4.0, 2.0, 5.0]);
        cow.hurt_ticks = HURT_TICKS;
        cow.hit_by_egg([3.0, 0.5, 4.0], 2026, 9, 20);
        let [x, y, z] = cow.velocity();
        assert!((x - 0.18).abs() < 1e-12 && (z - 0.24).abs() < 1e-12);
        assert_eq!(y, 0.2);
        assert_eq!(cow.health, 10);
        assert_eq!(cow.hurt_ticks, HURT_TICKS);
        assert_eq!(flee_state(&cow).1, 60);

        // AI would stop at the edge of this block. The egg impulse still moves the cow.
        let mut world = World::default();
        world.insert_chunk(world::Chunk::empty(0, 0));
        world.set_block(3, 1, 4, blocks::STONE);
        cow.hurt_ticks -= 1;
        cow.tick(&world, 2026, 9, 21, None);
        assert!(cow.pos()[0] > 4.0 && cow.pos()[1] > 2.0 && cow.pos()[2] > 5.0);
        assert_eq!(flee_state(&cow).1, 59);
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
                    let cause = cow.tick(world, 5, 7, time, None);
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
            assert_eq!(chicken.tick(&world, 5, 7, time, None), None);
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
    fn sheep_spawn_colors_follow_the_weighted_distribution_and_repeat() {
        let spawn = || {
            let mut server = Server::new(2026, Generator::Flat);
            for _ in 0..10_000 {
                server.spawn_mob(MobKind::Sheep, [0.5, 1.0, 0.5]);
            }
            server
                .mobs
                .values()
                .map(|mob| mob.wool_color)
                .collect::<Vec<_>>()
        };
        let colors = spawn();
        assert_eq!(colors, spawn());
        let mut totals = [0; 4];
        for color in colors {
            totals[color as usize] += 1;
        }
        for (actual, expected) in totals.into_iter().zip([7000_i32, 1500, 1000, 500]) {
            assert!((actual - expected).abs() <= 150, "{totals:?}");
        }
    }

    fn brown_sheep(mode: GameMode) -> (Server, u32) {
        let (mut server, id) = combat(mode);
        let mut sheep = Mob::new(MobKind::Sheep, server.mobs[&id].pos());
        sheep.wool_color = WoolColor::Brown;
        server.mobs.insert(id, sheep);
        (server, id)
    }

    #[test]
    fn shearing_drops_the_colored_wool_and_wears_or_breaks_shears_only_in_survival() {
        for mode in [GameMode::Survival, GameMode::Creative] {
            for damage in [0, 119] {
                let (mut server, id) = brown_sheep(mode);
                hold(&mut server, "shears");
                let inventory = &mut server.clients.get_mut(&1).unwrap().inventory;
                let stack = crate::Stack {
                    damage,
                    ..inventory.selected_stack().unwrap()
                };
                inventory.set(0, Some(stack)).unwrap();
                let [x, y, z] = server.mobs[&id].pos();
                let hash = server.state_hash();
                server.apply(1, C2S::UseEntity { id });
                assert_ne!(server.state_hash(), hash);
                assert_eq!(server.mobs[&id].wool_ticks, WOOL_REGROW_TICKS);
                assert_eq!(server.entities.len(), 1);
                let drop = server.entities.values().next().unwrap();
                assert_eq!(drop.item, items::by_name("brown_wool").unwrap());
                assert!((1..=3).contains(&drop.count));
                assert_eq!(
                    drop.count,
                    1 + (sample(server.seed, id, server.game_time, SHEAR_LOOT_SALT) % 3) as u8
                );
                assert_eq!(drop.pos, [x, y + spec(MobKind::Sheep).height / 2.0, z]);
                assert_eq!(drop.velocity, [0.0, 0.1, 0.0]);
                assert_eq!(drop.pickup_delay, 10);
                let remaining = match (mode, damage) {
                    (GameMode::Survival, 119) => None,
                    (GameMode::Survival, _) => Some(crate::Stack {
                        damage: damage + 1,
                        ..stack
                    }),
                    (GameMode::Creative, _) => Some(stack),
                };
                assert_eq!(server.clients[&1].inventory.selected_stack(), remaining);
                let packets = decoded(&mut server);
                assert!(packets.contains(&(1, S2C::Shear)));
                assert!(packets.contains(&(
                    1,
                    S2C::SheepAppearance {
                        id,
                        color: WoolColor::Brown,
                        sheared: true
                    }
                )));
                assert_eq!(packets.contains(&(1, S2C::ToolBreak)), remaining.is_none());
            }
        }
    }

    #[test]
    fn use_entity_ignores_invalid_targets_tools_and_connections_like_attack() {
        let (mut server, id) = brown_sheep(GameMode::Survival);
        let pos = server.mobs[&id].pos();
        let use_shears = C2S::UseEntity { id };
        let rejected = server.stats.packets_rejected;
        hold(&mut server, "stick");
        server.apply(1, use_shears.clone());
        assert!(!server.mobs[&id].sheared());

        hold(&mut server, "shears");
        server.spawn_cow(pos);
        server.apply(1, C2S::UseEntity { id: id + 1 });
        server.apply(1, C2S::UseEntity { id: 0 });
        server.mobs.get_mut(&id).unwrap().wool_ticks = 1;
        server.apply(1, use_shears.clone());
        assert_eq!(server.mobs[&id].wool_ticks, 1);
        server.mobs.get_mut(&id).unwrap().wool_ticks = 0;

        server.mobs.get_mut(&id).unwrap().body.position = [14.0, 1.0, 5.5];
        server.apply(1, use_shears.clone());
        assert!(!server.mobs[&id].sheared());
        server.mobs.get_mut(&id).unwrap().body.position = [160.5, 1.0, 5.5];
        assert!(!server.world.chunks.contains_key(&(10, 0)));
        let client = server.clients.get_mut(&1).unwrap();
        let player_pos = client.pos;
        client.pos[0] = 159.5;
        server.apply(1, use_shears.clone());
        assert!(!server.mobs[&id].sheared());
        server.mobs.get_mut(&id).unwrap().body.position = pos;

        let client = server.clients.get_mut(&1).unwrap();
        client.pos = player_pos;
        client.joined = false;
        server.apply(1, use_shears.clone());
        assert!(!server.mobs[&id].sheared());
        let client = server.clients.get_mut(&1).unwrap();
        client.joined = true;
        client.health.vitals.dead = true;
        server.apply(1, use_shears);
        assert!(!server.mobs[&id].sheared());
        assert!(server.entities.is_empty());
        assert_eq!(
            server.clients[&1]
                .inventory
                .selected_stack()
                .unwrap()
                .damage,
            0
        );
        assert_eq!(server.stats.packets_rejected, rejected);
        assert!(decoded(&mut server).is_empty());
    }

    #[test]
    fn sheep_regrows_wool_after_2400_loaded_ticks_and_can_be_sheared_again() {
        let (mut server, id) = brown_sheep(GameMode::Creative);
        hold(&mut server, "shears");
        let packet = C2S::UseEntity { id }.encode();
        server.handle_packet(1, &packet);
        server.handle_packet(1, &packet);
        server.tick();
        assert_eq!(server.entities.len(), 1);
        assert_eq!(server.mobs[&id].wool_ticks, 2399);
        let hash = server.state_hash();
        let mob = server.mobs.get_mut(&id).unwrap();
        mob.wool_ticks -= 1;
        assert_ne!(server.state_hash(), hash);
        server.mobs.get_mut(&id).unwrap().wool_ticks += 1;
        assert_eq!(server.state_hash(), hash);
        server.mobs.get_mut(&id).unwrap().wool_color = WoolColor::Gray;
        assert_ne!(server.state_hash(), hash);
        server.mobs.get_mut(&id).unwrap().wool_color = WoolColor::Brown;
        for _ in 1..2399 {
            server.game_time += 1;
            server.tick_mobs();
        }
        assert_eq!(server.mobs[&id].wool_ticks, 1);
        server.take_outbox();
        server.game_time += 1;
        server.tick_mobs();
        assert_eq!(server.mobs[&id].wool_ticks, 0);
        assert!(decoded(&mut server).contains(&(
            1,
            S2C::SheepAppearance {
                id,
                color: WoolColor::Brown,
                sheared: false
            }
        )));
        server.clients.get_mut(&1).unwrap().pos = server.mobs[&id].pos();
        server.apply(1, C2S::UseEntity { id });
        assert!(server.mobs[&id].sheared());
        assert_eq!(server.entities.len(), 2);
    }

    #[test]
    fn sheep_death_uses_fleece_color_or_omits_wool_without_changing_mutton_roll() {
        for sheared in [false, true] {
            let (mut server, id) = brown_sheep(GameMode::Survival);
            let mob = server.mobs.get_mut(&id).unwrap();
            mob.health = 1;
            mob.wool_ticks = u16::from(sheared);
            let meat = 1 + (sample(server.seed, id, server.game_time, LOOT_SALT + 1) % 2) as u8;
            server.apply(1, C2S::Attack { id });
            assert!(!server.mobs.contains_key(&id));
            let drops: Vec<_> = server
                .entities
                .values()
                .map(|drop| (drop.item, drop.count))
                .collect();
            let mut expected = vec![(items::by_name("raw_mutton").unwrap(), meat)];
            if !sheared {
                expected.insert(0, (items::by_name("brown_wool").unwrap(), 1));
            }
            assert_eq!(drops, expected);
        }
    }

    #[test]
    fn sheep_body_uses_the_cow_sized_hitbox_with_health_eight_and_head_height() {
        let mut world = arena(16);
        let pos = [2.5, 1.0, 2.5];
        let mut sheep = Mob::new(MobKind::Sheep, pos);
        let bounds = sheep.body.bounds();
        assert_eq!(bounds.min, [2.5 - 0.45, 1.0, 2.5 - 0.45]);
        assert_eq!(bounds.max, [2.5 + 0.45, 1.0 + 1.3, 2.5 + 0.45]);
        assert_eq!(sheep.health, 8);
        assert_eq!(spec(MobKind::Sheep).head_offset, 1.1);
        assert_eq!(
            spec(MobKind::Sheep).walk_forward,
            spec(MobKind::Cow).walk_forward
        );
        assert_eq!(
            spec(MobKind::Sheep).flee_forward,
            spec(MobKind::Cow).flee_forward
        );
        assert_eq!(spec(MobKind::Sheep).max_fall_speed, None);
        assert!(spec(MobKind::Sheep).takes_fall_damage);

        // Head y is feet + 1.1, so a solid at y=2 starts covering it at feet 0.9.
        world.set_block(2, 2, 2, blocks::STONE);
        sheep.body.position[1] = 0.89;
        for _ in 0..SUFFOCATION_INTERVAL {
            assert_eq!(sheep.environment_damage(&world, sheep.pos()), None);
        }
        sheep.body.position[1] = 0.9;
        for _ in 1..SUFFOCATION_INTERVAL {
            assert_eq!(sheep.environment_damage(&world, sheep.pos()), None);
        }
        assert_eq!(
            sheep.environment_damage(&world, sheep.pos()),
            Some(DeathCause::Suffocation)
        );
        assert_eq!(sheep.health, 7);
    }

    #[test]
    fn sheep_drops_wool_and_mutton_and_lava_cooks_only_the_meat() {
        let wool = items::by_name("white_wool").unwrap();
        let raw = items::by_name("raw_mutton").unwrap();
        let cooked = items::by_name("cooked_mutton").unwrap();
        for burned in [false, true] {
            let (mut server, id) = combat(GameMode::Creative);
            let pos = server.mobs[&id].pos();
            server.mobs.insert(id, Mob::new(MobKind::Sheep, pos));
            let rolled_at = if burned {
                server.world.set_block(7, 1, 5, blocks::LAVA);
                for (x, z) in [(6, 5), (8, 5), (7, 4), (7, 6)] {
                    for y in 1..=2 {
                        server.world.set_block(x, y, z, blocks::STONE);
                    }
                }
                for _ in 0..2 * usize::from(LAVA_INTERVAL) {
                    server.tick();
                }
                server.game_time
            } else {
                hold(&mut server, "iron_axe");
                attack(&mut server, id);
                server.tick();
                assert_eq!(server.mobs[&id].health, 2);
                for _ in 1..HURT_TICKS {
                    server.tick();
                }
                attack(&mut server, id);
                server.tick();
                server.game_time - 1
            };
            assert!(!server.mobs.contains_key(&id));
            let drops: Vec<_> = server
                .entities
                .values()
                .map(|drop| (drop.item, drop.count))
                .collect();
            let mutton = 1 + (sample(server.seed, id, rolled_at, LOOT_SALT + 1) % 2) as u8;
            let meat = if burned { cooked } else { raw };
            assert_eq!(drops, vec![(wool, 1), (meat, mutton)]);
        }
        assert_eq!(items::SHEEP_LOOT, [(wool, 1, 1), (raw, 1, 2)]);
        assert_eq!(smelting::output(raw), Some(cooked));
        assert_eq!(smelting::output(wool), None);
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
                damage: 0,
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
            damage: 0,
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
    fn lava_death_drops_loot_on_the_last_dry_fence() {
        let (mut server, id) = combat(GameMode::Creative);
        let fence = [8.5, 2.5, 5.5];
        assert_ne!(server.mobs[&id].last_dry_pos, fence);
        server.world.set_block(8, 1, 5, blocks::OAK_FENCE);
        server.mobs.get_mut(&id).unwrap().body.position = fence;
        server.tick();
        assert_eq!(server.mobs[&id].last_dry_pos, fence);

        server.world.set_block(10, 1, 5, blocks::LAVA);
        let cow = server.mobs.get_mut(&id).unwrap();
        cow.body.position = [10.5, 1.0, 5.5];
        cow.health = LAVA_DAMAGE;
        cow.lava_ticks = LAVA_INTERVAL - 1;
        server.tick();

        assert!(!server.mobs.contains_key(&id));
        assert_eq!(server.entities.len(), 1);
        let drop = server.entities.values().next().unwrap();
        assert_eq!(drop.item, items::by_name("cooked_beef").unwrap());
        assert_eq!(drop.pos, [fence[0], fence[1] + 0.65, fence[2]]);
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
        assert_eq!(cow.tick(&world, 5, 7, time, None), Some(DeathCause::Lava));
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
        assert_eq!(cow.tick(&world, 5, 7, time, None), Some(DeathCause::Lava));
        assert_eq!(flee_state(&cow).1, FLEE_TICKS);
        let escaped = (time + 1..=time + i64::from(FLEE_TICKS)).any(|tick| {
            cow.hurt_ticks = cow.hurt_ticks.saturating_sub(1);
            cow.tick(&world, 5, 7, tick, None);
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
                walker.tick(&server.world, server.seed, id, server.game_time + 1, None);
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
                cow.tick(&world, 5, 7, tick, None);
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
        cow.tick(&world, 5, 7, 1, None);
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
            cow.tick(&world, 5, 7, 1, None);
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
        cow.tick(&world, 5, 7, 1, None);
        assert_eq!(flee_state(&cow), (first, 59, 1));
        cow.tick(&world, 5, 7, 2, None);
        assert_eq!(
            flee_state(&cow),
            (flee_target(cow.pos(), 5, 7, 2, None), 58, 0)
        );

        let mut cow = fleeing_toward([2.5, 2.5]);
        let before = cow.pos();
        cow.tick(&world, 5, 7, 3, None);
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
            assert!(server
                .mobs()
                .values()
                .all(|mob| mob.kind == MobKind::Chicken));
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
            (800, 1, MobKind::Sheep),
            (1200, 2, MobKind::Cow),
            (2000, 1, MobKind::Pig),
            (2400, 2, MobKind::Chicken),
            (2800, 1, MobKind::Sheep),
            (3600, 1, MobKind::Pig),
            (5200, 2, MobKind::Sheep),
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
    fn hostiles_spawn_only_at_night_on_their_own_interval_in_both_modes() {
        for mode in [GameMode::Creative, GameMode::Survival] {
            let mut server = joined(mode);
            let origin = server.clients[&1].pos;
            for (time, day, expected) in [
                (199, 18000, 0),
                (200, 6000, 0),
                (200, 12000, 0),
                (200, 12999, 0),
                (200, 13000, 1),
                (200, 22999, 1),
                (200, 23000, 0),
                (200, 24000 + 18000, 1),
            ] {
                server.mobs.clear();
                server.set_time(time - 1, day - 1);
                server.tick();
                assert_eq!(server.mobs.len(), expected, "tick {time}, day {day}");
                for mob in server.mobs.values() {
                    assert_eq!(mob.kind, MobKind::Creeper);
                    assert!(
                        (24.0 * 24.0..=48.0 * 48.0).contains(&distance_squared(mob.pos(), origin))
                    );
                }
            }
        }
    }

    #[test]
    fn night_spawn_requires_zero_block_light_at_the_feet() {
        let mut server = joined(GameMode::Creative);
        assert!(!server.world.lighting_enabled());
        let night_tick = |server: &mut Server| {
            server.mobs.clear();
            server.set_time(199, 17999);
            server.tick();
        };
        night_tick(&mut server);
        let [x, y, z] = server
            .mobs
            .values()
            .next()
            .unwrap()
            .pos()
            .map(|axis| axis.floor() as i32);

        assert!(server
            .world
            .set_block(x + 5, y, z, blocks::LAMP_BLOCK)
            .is_some());
        night_tick(&mut server);
        assert!(server.mobs.is_empty());

        // From the lamp, any route around this wall above ground exceeds 14 steps.
        for wall_y in y..=y + 5 {
            for wall_z in z - 5..=z + 5 {
                assert!(server
                    .world
                    .set_block(x + 4, wall_y, wall_z, blocks::STONE)
                    .is_some());
            }
        }
        night_tick(&mut server);
        assert_eq!(server.mobs.len(), 1);

        server.world.set_block(x + 5, y, z, blocks::AIR);
        // Place the lamp on the open side to check the exact light cutoff.
        assert!(server
            .world
            .set_block(x - 14, y, z, blocks::LAMP_BLOCK)
            .is_some());
        night_tick(&mut server);
        assert!(server.mobs.is_empty());
        server.world.set_block(x - 14, y, z, blocks::AIR);
        assert!(server
            .world
            .set_block(x - 15, y, z, blocks::LAMP_BLOCK)
            .is_some());
        night_tick(&mut server);
        assert_eq!(server.mobs.len(), 1);
    }

    #[test]
    fn all_hostiles_share_a_cap_independent_of_animals() {
        let mut server = joined(GameMode::Creative);
        let pos = server.spawn();
        let players = [(1, pos)];
        for _ in 0..LOCAL_LIMIT {
            server.spawn_cow(pos);
        }
        for time in (200..=1200).step_by(200) {
            server.game_time = time;
            server.spawn_hostile(1, pos, &players);
        }
        assert_eq!(server.mobs.len(), LOCAL_LIMIT + HOSTILE_LOCAL_LIMIT);
        assert_eq!(
            server
                .mobs
                .values()
                .filter(|mob| mob.hostile.is_some())
                .map(|mob| mob.kind)
                .collect::<Vec<_>>(),
            [
                MobKind::Creeper,
                MobKind::Zombie,
                MobKind::Creeper,
                MobKind::Skeleton,
            ]
        );

        server.mobs.retain(|_, mob| mob.hostile.is_some());
        server.game_time = 400;
        server.spawn_herd(1, pos, &players);
        let herd = |server: &Server| {
            server
                .mobs
                .values()
                .filter(|mob| mob.hostile.is_none())
                .map(|mob| (mob.kind, mob.pos()))
                .collect::<Vec<_>>()
        };
        let with_hostiles = herd(&server);
        server.mobs.clear();
        server.spawn_herd(1, pos, &players);
        assert_eq!(herd(&server), with_hostiles);
        assert_eq!(with_hostiles.len(), 3);
    }

    #[test]
    fn zombie_spawn_column_uses_the_highest_solid_and_requires_clearance() {
        let mut world = arena(16);
        assert_eq!(hostile_surface(&world, 5, 5), Some([5.5, 1.0, 5.5]));
        assert_eq!(hostile_surface(&world, 16, 5), None);
        for state in [
            blocks::OAK_LEAVES,
            blocks::OAK_SLAB,
            blocks::WATER,
            blocks::LAVA,
        ] {
            world.set_block(5, 1, 5, state);
            assert_eq!(hostile_surface(&world, 5, 5), None, "state {state}");
        }
        world.set_block(5, 1, 5, blocks::AIR);
        world.set_block(5, 10, 5, blocks::GLASS);
        assert_eq!(hostile_surface(&world, 5, 5), Some([5.5, 11.0, 5.5]));
        world.set_block(5, 12, 5, blocks::WATER);
        assert_eq!(hostile_surface(&world, 5, 5), None);

        let mut server = joined(GameMode::Creative);
        let pos = server.spawn();
        server.game_time = 200;
        server.spawn_hostile(1, pos, &[(1, pos)]);
        let candidate = server.mobs.values().next().unwrap().pos();
        server.mobs.clear();
        server.spawn_hostile(1, pos, &[(1, pos), (2, candidate)]);
        assert!(server.mobs.is_empty());
    }

    #[test]
    fn zombie_spawn_column_rejects_fluids_above_the_clearance() {
        let mut world = arena(16);
        assert_eq!(hostile_surface(&world, 5, 5), Some([5.5, 1.0, 5.5]));
        for fluid in [blocks::WATER, blocks::LAVA] {
            world.set_block(5, 3, 5, fluid);
            assert_eq!(hostile_surface(&world, 5, 5), None, "fluid {fluid}");
        }
    }

    #[test]
    fn zombie_sunlight_hits_every_twenty_exposed_day_ticks() {
        let (mut server, id) = combat(GameMode::Creative);
        let pos = server.mobs[&id].pos();
        server.mobs.insert(id, Mob::new(MobKind::Zombie, pos));
        server.set_time(0, 6000);
        for tick in 1..=40 {
            server.tick();
            let mob = &server.mobs[&id];
            assert_eq!(mob.health, 20 - 2 * (tick / 20));
            if tick % 20 == 0 {
                assert_eq!(mob.hurt_ticks, HURT_TICKS);
                assert!(!matches!(mob.ai, Wander::Fleeing { .. }));
                assert!(server
                    .take_outbox()
                    .iter()
                    .any(|(_, bytes)| { S2C::decode(bytes) == Ok(S2C::MobHurt { id }) }));
            }
        }
        server.set_time(40, 11999);
        for _ in 0..40 {
            server.tick();
        }
        assert_eq!(server.mobs[&id].health, 16);
        assert_eq!(server.mobs[&id].hostile.as_ref().unwrap().sunlight_ticks, 0);
    }

    #[test]
    fn zombie_sunlight_is_blocked_by_roof_shapes_and_water() {
        let pos = [5.5, 1.0, 5.5];
        let mut world = arena(16);
        for (y, state) in [
            (1, blocks::WATER),
            (2, blocks::WATER),
            (30, blocks::WATER),
            (30, blocks::OAK_SLAB),
            (MIN_Y + HEIGHT - 1, blocks::GLASS),
        ] {
            world.set_block(5, y, 5, state);
            let mut zombie = Mob::new(MobKind::Zombie, pos);
            for _ in 0..40 {
                assert!(!zombie.sunlight_hit(&world, true));
            }
            assert_eq!(zombie.health, 20);
            world.set_block(5, y, 5, blocks::AIR);
        }
    }

    #[test]
    fn zombie_sunlight_counts_only_overhead_shapes_in_the_head_cell() {
        let pos = [5.5, 1.5, 5.5];
        let mut world = arena(16);
        for (state, health) in [
            (blocks::OAK_SLAB + 1, 20),
            (blocks::OAK_SLAB, 18),
            (blocks::AIR, 18),
        ] {
            world.set_block(5, 3, 5, state);
            let mut zombie = Mob::new(MobKind::Zombie, pos);
            for _ in 0..SUNLIGHT_INTERVAL {
                zombie.sunlight_hit(&world, true);
            }
            assert_eq!(zombie.health, health, "state {state}");
        }
    }

    #[test]
    fn zombie_chases_survival_and_hits_every_twenty_ticks_with_box_reach() {
        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        let pos = server.mobs[&id].pos();
        server.mobs.insert(id, Mob::new(MobKind::Zombie, pos));
        server.tick();
        let mob = &server.mobs[&id];
        assert!(mob.pos()[0] < pos[0]);
        assert_eq!(mob.yaw, 90.0);
        assert_eq!(server.clients[&1].health.vitals.health, 20);
        for _ in 0..20 {
            if server.clients[&1].health.vitals.health != 20 {
                break;
            }
            server.tick();
        }
        assert_eq!(server.clients[&1].health.vitals.health, 17);
        for remaining in (1..=20).rev() {
            assert_eq!(
                server.mobs[&id].hostile.as_ref().unwrap().attack_ticks,
                remaining
            );
            assert_eq!(server.clients[&1].health.vitals.health, 17);
            server.tick();
        }
        assert_eq!(server.clients[&1].health.vitals.health, 14);

        let mut zombie = Mob::new(MobKind::Zombie, [0.0; 3]);
        assert!(!zombie.attacks([1.401, 0.0, 0.0]));
        assert!(!zombie.attacks([0.0, 2.751, 0.0]));
        assert!(!zombie.attacks([1.2, 2.55, 0.0]));
        assert!(zombie.attacks([1.4, 0.0, 0.0]));
    }

    #[test]
    fn zombie_ignores_creative_players_and_takes_knockback_without_fleeing() {
        let (mut server, id) = combat(GameMode::Creative);
        let player = server.clients[&1].pos;
        let pos = [player[0] + 1.0, player[1], player[2]];
        server.mobs.insert(id, Mob::new(MobKind::Zombie, pos));
        server.set_time(0, 18000);
        server.tick();
        assert_eq!(server.mobs[&id].pos(), pos);
        assert_eq!(server.clients[&1].health.vitals.health, 20);
        attack(&mut server, id);
        server.tick();
        let mob = &server.mobs[&id];
        assert_eq!(mob.health, 19);
        assert_eq!(mob.pos(), [pos[0] + 0.4, pos[1] + 0.36, pos[2]]);
        assert_eq!(mob.ai, Wander::Idle);
    }

    #[test]
    fn zombie_death_drops_rotten_flesh_in_sunlight_and_lava() {
        let item = items::by_name("rotten_flesh").unwrap();
        assert_eq!(items::info(item).unwrap().food, Some(4));
        assert_eq!(smelting::output(item), None);
        for lava in [false, true] {
            let (mut server, id) = combat(GameMode::Creative);
            let pos = server.mobs[&id].pos();
            if lava {
                let [x, y, z] = pos.map(|v| v.floor() as i32);
                server.world.set_block(x, y, z, blocks::LAVA);
            }
            for expected in 0..=2 {
                let time = (1..)
                    .find(|&t| sample(server.seed, id, t, LOOT_SALT) % 3 == expected)
                    .unwrap();
                server.set_time(time - 1, 6000);
                let mut zombie = Mob::new(MobKind::Zombie, pos);
                zombie.health = 1;
                zombie.hostile.as_mut().unwrap().sunlight_ticks = SUNLIGHT_INTERVAL - 1;
                zombie.lava_ticks = LAVA_INTERVAL - 1;
                server.mobs.insert(id, zombie);
                server.entities.clear();
                server.tick();
                assert!(!server.mobs.contains_key(&id));
                assert!(server.entities.values().all(|drop| drop.item == item));
                assert_eq!(
                    server
                        .entities
                        .values()
                        .map(|drop| u64::from(drop.count))
                        .sum::<u64>(),
                    expected
                );
            }
        }
    }

    #[test]
    fn zombie_kills_a_player_with_cause_six_and_drops_their_inventory() {
        let (mut server, id) = combat(GameMode::Survival);
        let pos = server.clients[&1].pos;
        server.set_time(0, 18000);
        hold(&mut server, "raw_beef");
        server.clients.get_mut(&1).unwrap().health.vitals.health = 3;
        server.mobs.insert(id, Mob::new(MobKind::Zombie, pos));
        server.tick();
        assert!(server.clients[&1].health.vitals.dead);
        assert_eq!(server.clients[&1].health.vitals.cause as u8, 6);
        let save = server.inventory_data(1).unwrap();
        assert_eq!(
            crate::Inventory::from_bytes(&save).unwrap().1.cause,
            DeathCause::Zombie
        );
        assert!(server.clients[&1]
            .inventory
            .slots()
            .iter()
            .all(Option::is_none));
        assert_eq!(server.entities.len(), 1);
        assert!(server.take_outbox().iter().any(|(player, bytes)| {
            *player == 1
                && matches!(
                    S2C::decode(bytes),
                    Ok(S2C::PlayerStatus {
                        health: 0,
                        cause: 6,
                        ..
                    })
                )
        }));
    }

    fn knockback_packets(server: &mut Server) -> Vec<(u32, [f64; 3])> {
        decoded(server)
            .into_iter()
            .filter_map(|(client, packet)| match packet {
                S2C::PlayerKnockback { velocity } => Some((client, velocity)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn zombie_attack_knockback_uses_the_horizontal_direction_and_skips_death() {
        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        let player = server.clients[&1].pos;
        let zombie_at = [player[0] + 0.8, player[1], player[2]];
        server.mobs.insert(id, Mob::new(MobKind::Zombie, zombie_at));
        server.take_outbox();
        server.tick();
        let zombie = server.mobs[&id].pos();
        let player = server.clients[&1].pos;
        assert!(zombie[0] > player[0]);
        let expected = zombie_knockback(zombie, player);
        assert_eq!(knockback_packets(&mut server), [(1, expected)]);
        assert!(expected[0] < 0.0);
        assert_eq!(expected[1], ZOMBIE_KNOCKBACK_VERTICAL);
        let horizontal = (expected[0] * expected[0] + expected[2] * expected[2]).sqrt();
        assert_eq!(horizontal, ZOMBIE_KNOCKBACK_HORIZONTAL);
        assert_eq!(server.clients[&1].health.vitals.health, 17);

        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        let player = server.clients[&1].pos;
        server.mobs.insert(id, Mob::new(MobKind::Zombie, player));
        server.take_outbox();
        server.tick();
        assert_eq!(server.mobs[&id].pos()[0], player[0]);
        assert_eq!(server.mobs[&id].pos()[2], player[2]);
        assert_eq!(
            knockback_packets(&mut server),
            [(1, [0.0, ZOMBIE_KNOCKBACK_VERTICAL, 0.0])]
        );

        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        let player = server.clients[&1].pos;
        server.clients.get_mut(&1).unwrap().health.vitals.health = ZOMBIE_ATTACK_DAMAGE;
        server.mobs.insert(id, Mob::new(MobKind::Zombie, player));
        server.take_outbox();
        server.tick();
        assert!(server.clients[&1].health.vitals.dead);
        assert!(knockback_packets(&mut server).is_empty());
    }

    fn report_knockback_prediction(server: &mut Server, position: [f64; 3]) -> Vec<(u32, S2C)> {
        let rejected = server.stats.positions_rejected;
        let [x, y, z] = position;
        server.handle_packet(
            1,
            &C2S::PlayerPos {
                x,
                y,
                z,
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode(),
        );
        server.tick();
        let packets = decoded(server);
        let tick = server.game_time;
        assert_eq!(
            server.stats.positions_rejected, rejected,
            "tick={tick} pos={position:?}"
        );
        assert_eq!(
            server.client_position(1),
            Some(position),
            "tick={tick} pos={position:?}"
        );
        assert!(
            packets
                .iter()
                .all(|(_, packet)| !matches!(packet, S2C::PlayerCorrect { .. })),
            "tick={tick} pos={position:?}"
        );
        packets
    }

    #[test]
    fn zombie_knockback_prediction_is_accepted_on_open_ground_and_against_a_wall() {
        fn launch(wall: bool) {
            let (mut server, id) = combat(GameMode::Survival);
            server.set_time(0, 18000);
            let origin = server.clients[&1].pos;
            server.mobs.insert(
                id,
                Mob::new(MobKind::Zombie, [origin[0] + 0.8, origin[1], origin[2]]),
            );
            if wall {
                let block_x = origin[0].floor() as i32 - 1;
                let block_z = origin[2].floor() as i32;
                for y in 1..=3 {
                    for z in block_z - 1..=block_z + 1 {
                        server.world.set_block(block_x, y, z, blocks::STONE);
                    }
                }
            }
            server.take_outbox();
            server.tick();
            let (_, velocity) = knockback_packets(&mut server)
                .into_iter()
                .next()
                .expect("knockback");
            server.mobs.remove(&id);
            let mut body = physics::Player::new(server.client_position(1).unwrap());
            body.on_ground = true;
            body.apply_knockback(
                velocity,
                false,
                &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
            );
            let mut left_ground = false;
            let mut landed = false;
            for _ in 0..30 {
                body.tick(
                    physics::Input::default(),
                    &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
                );
                left_ground |= !body.on_ground;
                report_knockback_prediction(&mut server, body.position);
                if left_ground && body.on_ground {
                    landed = true;
                    break;
                }
            }
            assert!(left_ground && landed, "wall={wall} body={body:?}");
            if wall {
                let face = origin[0].floor();
                assert!(
                    body.position[0] - physics::WIDTH / 2.0 >= face - 1e-6,
                    "entered the wall: {body:?}"
                );
                assert!(body.position[0] < origin[0], "{body:?}");
            } else {
                assert!(origin[0] - body.position[0] > 0.5, "{body:?}");
            }
        }
        launch(false);
        launch(true);
    }

    fn assert_knockback_trajectory_lands(jump: bool, attack_ticks: &[usize]) {
        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        let origin = server.client_position(1).unwrap();
        let mut body = Player::new(origin);
        body.on_ground = true;
        let mut left_ground = false;
        let mut hits = 0;
        for tick in 0..30 {
            // At tick 0 the player can receive attacks before taking the first step.
            if tick > 0 {
                body.tick(
                    physics::Input {
                        jump: jump && tick == 1,
                        ..Default::default()
                    },
                    &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
                );
            }
            let attackers = attack_ticks.iter().filter(|&&when| when == tick).count();
            let zombie_ids = (id + hits as u32..).take(attackers);
            let [x, _, z] = body.position;
            for zombie_id in zombie_ids.clone() {
                server.mobs.insert(
                    zombie_id,
                    grounded(MobKind::Zombie, [x + 0.8, origin[1], z]),
                );
            }
            let packets = report_knockback_prediction(&mut server, body.position);
            let mut received = 0;
            for (client, packet) in packets {
                if let S2C::PlayerKnockback { velocity } = packet {
                    assert_eq!(client, 1);
                    if jump {
                        assert!(!body.on_ground, "hit on jump tick {tick}");
                    }
                    let vy = body.velocity[1];
                    body.apply_knockback(
                        velocity,
                        false,
                        &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
                    );
                    if !body.on_ground {
                        assert_eq!(body.velocity[1], vy, "airborne hit on tick {tick}");
                    }
                    received += 1;
                }
            }
            assert_eq!(received, attackers, "knockback packets on tick {tick}");
            hits += received;
            for zombie_id in zombie_ids {
                server.mobs.remove(&zombie_id);
            }
            if left_ground && body.on_ground {
                assert_eq!(hits, attack_ticks.len(), "landed before all attacks");
                assert_eq!(body.position[1], origin[1]);
                return;
            }
            left_ground |= !body.on_ground;
        }
        panic!("player did not land after attacks at {attack_ticks:?}: {body:?}");
    }

    #[test]
    fn zombie_knockback_prediction_is_accepted_at_each_airborne_tick_of_a_jump() {
        // A flat-ground jump is airborne for ticks 1–11, with its apex on tick 6.
        for tick in 1..=11 {
            assert_knockback_trajectory_lands(true, &[tick]);
        }
    }

    #[test]
    fn zombie_knockback_prediction_is_accepted_for_same_and_consecutive_tick_attacks() {
        assert_knockback_trajectory_lands(false, &[0, 0]);
        assert_knockback_trajectory_lands(false, &[0, 1]);
    }

    #[test]
    fn excessive_rise_without_knockback_still_gets_a_position_correction() {
        let (mut server, _) = combat(GameMode::Survival);
        let [x, y, z] = server.client_position(1).unwrap();
        for rise in [0.5, 1.0, 1.5] {
            let packets = report_knockback_prediction(&mut server, [x, y + rise, z]);
            assert!(packets
                .iter()
                .all(|(_, packet)| !matches!(packet, S2C::PlayerKnockback { .. })));
        }
        let rejected = server.stats.positions_rejected;
        server.handle_packet(
            1,
            &C2S::PlayerPos {
                x,
                y: y + 1.625,
                z,
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode(),
        );
        server.tick();
        assert_eq!(server.client_position(1), Some([x, y + 1.5, z]));
        assert_eq!(server.stats.positions_rejected, rejected + 1);
        let packets = decoded(&mut server);
        assert!(packets.contains(&(1, S2C::PlayerCorrect { x, y: y + 1.5, z })));
        assert!(packets
            .iter()
            .all(|(_, packet)| !matches!(packet, S2C::PlayerKnockback { .. })));
    }

    #[test]
    fn burning_follows_sunlight_and_lava_and_is_sent_after_a_new_spawn() {
        let (mut server, id) = combat(GameMode::Creative);
        let pos = server.mobs[&id].pos();
        server.mobs.insert(id, Mob::new(MobKind::Zombie, pos));
        server.set_time(0, 6000);
        server.take_outbox();
        server.tick();
        assert!(server.mobs[&id].burning);
        assert!(decoded(&mut server).contains(&(1, S2C::MobBurning { id, burning: true })));

        server.connect(2);
        {
            let viewer = server.clients.get_mut(&2).unwrap();
            viewer.joined = true;
            viewer.sent.insert(server.mobs[&id].chunk());
        }
        server.sync_mobs();
        let spawned: Vec<_> = decoded(&mut server)
            .into_iter()
            .filter(|(client, _)| *client == 2)
            .map(|(_, packet)| packet)
            .collect();
        assert!(matches!(
            spawned.as_slice(),
            [
                S2C::MobSpawn { id: spawn_id, .. },
                S2C::MobBurning {
                    id: burn_id,
                    burning: true,
                },
            ] if *spawn_id == id && *burn_id == id
        ));

        for x in 0..16 {
            for z in 0..16 {
                server.world.set_block(x, 4, z, blocks::STONE);
            }
        }
        server.tick();
        assert!(!server.mobs[&id].burning);
        let shaded = decoded(&mut server);
        assert!(shaded.contains(&(1, S2C::MobBurning { id, burning: false })));
        assert!(shaded.contains(&(2, S2C::MobBurning { id, burning: false })));

        let (mut server, id) = combat(GameMode::Creative);
        let pos = server.mobs[&id].pos();
        let [x, _, z] = pos.map(|value| value.floor() as i32);
        server.world.set_block(x, 1, z, blocks::LAVA);
        for (nx, nz) in [(x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)] {
            for y in 1..=3 {
                server.world.set_block(nx, y, nz, blocks::STONE);
            }
        }
        server.take_outbox();
        server.tick();
        assert!(server.mobs[&id].burning);
        assert_eq!(server.mobs[&id].kind, MobKind::Cow);
        assert!(decoded(&mut server).contains(&(1, S2C::MobBurning { id, burning: true })));
        server.tick();
        assert!(server.mobs[&id].burning);
        assert!(!decoded(&mut server)
            .iter()
            .any(|(_, packet)| matches!(packet, S2C::MobBurning { .. })));
    }

    #[test]
    fn hostile_selection_splits_three_ways_and_flat_spawns_are_fixed() {
        let mut counts = [0_usize; 3];
        for time in 1..=4096 {
            let roll = sample(2026, 1, time, HOSTILE_KIND_SALT) % 3;
            let expected = match roll {
                0 => MobKind::Zombie,
                1 => MobKind::Skeleton,
                _ => MobKind::Creeper,
            };
            assert_eq!(hostile_kind(2026, 1, time), expected);
            counts[roll as usize] += 1;
        }
        assert_eq!(counts, [1301, 1369, 1426]);
        let mut server = joined(GameMode::Survival);
        let pos = server.clients[&1].pos;
        let mut found = [None; 3];
        for seed in 1..8000 {
            if found.iter().all(Option::is_some) {
                break;
            }
            server.seed = seed;
            server.mobs.clear();
            server.game_time = 200;
            server.spawn_hostile(1, pos, &[(1, pos)]);
            let Some(kind) = server.mobs.values().next().map(|mob| mob.kind) else {
                continue;
            };
            let slot = match kind {
                MobKind::Zombie => 0,
                MobKind::Skeleton => 1,
                MobKind::Creeper => 2,
                _ => continue,
            };
            if found[slot].is_none() {
                found[slot] = Some(seed);
            }
        }
        assert_eq!(found, [Some(2), Some(5), Some(1)]);
        for (seed, expected) in [
            (2, MobKind::Zombie),
            (5, MobKind::Skeleton),
            (1, MobKind::Creeper),
        ] {
            let mut server = joined_with_seed(GameMode::Survival, seed);
            server.set_time(199, 18199);
            server.tick();
            assert_eq!(
                server.mobs.values().map(|mob| mob.kind).collect::<Vec<_>>(),
                [expected]
            );
        }
    }

    #[test]
    fn skeleton_stops_and_faces_at_ten_blocks_but_chases_far_or_occluded_targets() {
        let world = arena(16);
        let start = [2.5, 1.0, 2.5];
        let mut skeleton = Mob::new(MobKind::Skeleton, start);
        skeleton.body.on_ground = true;
        skeleton.body.velocity[0] = 0.1;
        skeleton.tick(&world, 2027, 7, 1, Some([12.5, 1.0, 2.5]));
        assert_eq!(skeleton.pos(), start);
        assert_eq!(skeleton.yaw, 270.0);
        skeleton.tick(&world, 2027, 7, 2, Some([13.5, 1.0, 2.5]));
        assert!(skeleton.pos()[0] > start[0]);

        let mut wall = world;
        wall.set_block(4, 2, 2, blocks::STONE);
        let before = skeleton.pos();
        skeleton.tick(&wall, 2027, 7, 3, Some([7.5, 1.0, 2.5]));
        assert!(skeleton.pos()[0] > before[0]);
        skeleton.hostile.as_mut().unwrap().shot_ticks = Some(0);
        assert!(skeleton.shoot(&wall, [7.5, 1.0, 2.5]).is_none());
        assert_eq!(skeleton.hostile.as_ref().unwrap().shot_ticks, Some(0));
        assert!(skeleton.shoot(&wall, [2.5, 1.0, 3.5]).is_some());
        assert!(!skeleton.attacks(skeleton.pos()));
    }

    #[test]
    fn skeleton_shoots_after_twenty_ticks_then_waits_forty_with_deterministic_results() {
        let setup = || {
            let (mut server, id) = combat(GameMode::Survival);
            server.set_time(0, 18000);
            server
                .mobs
                .insert(id, Mob::new(MobKind::Skeleton, [11.5, 1.0, 5.5]));
            (server, id)
        };
        let (mut a, id) = setup();
        let (mut b, _) = setup();
        let first_arrow = a.next_entity_id;
        assert_eq!(a.mobs[&id].hostile.as_ref().unwrap().shot_ticks, Some(20));
        for tick in 1..=60 {
            a.tick();
            b.tick();
            assert_eq!(a.state_hash(), b.state_hash(), "tick {tick}");
            let packets = a.take_outbox();
            assert_eq!(packets, b.take_outbox(), "tick {tick}");
            let expected = match tick {
                20 => Some((first_arrow, true)),
                60 => Some((first_arrow + 1, true)),
                _ => None,
            };
            assert_eq!(
                packets
                    .iter()
                    .find_map(|(_, bytes)| match S2C::decode(bytes).unwrap() {
                        S2C::ArrowSpawn { id, fresh, .. } => Some((id, fresh)),
                        _ => None,
                    }),
                expected,
                "tick {tick}"
            );
            if expected.is_some() {
                assert_eq!(a.mobs[&id].hostile.as_ref().unwrap().shot_ticks, Some(40));
            }
            if tick == 30 {
                assert_eq!(a.clients[&1].health.vitals.health, 17);
                assert!(!a.arrows.contains_key(&first_arrow));
            }
        }
    }

    #[test]
    fn skeleton_cooldown_contributes_to_hash_and_sunlight_drops_bones_and_arrows() {
        let (mut server, id) = combat(GameMode::Survival);
        let pos = server.mobs[&id].pos();
        server.mobs.insert(id, Mob::new(MobKind::Skeleton, pos));
        let before = server.state_hash();
        server
            .mobs
            .get_mut(&id)
            .unwrap()
            .hostile
            .as_mut()
            .unwrap()
            .shot_ticks = Some(0);
        assert_ne!(server.state_hash(), before);

        server.game_mode = GameMode::Creative;
        let bone = items::by_name("bone").unwrap();
        let arrow = items::by_name("arrow").unwrap();
        for name in [bone, arrow] {
            assert_eq!(items::info(name).unwrap().food, None);
        }
        for bones in 0..=2 {
            for arrows in 0..=2 {
                let time = (21..)
                    .find(|&t| {
                        sample(server.seed, id, t, LOOT_SALT) % 3 == bones
                            && sample(server.seed, id, t, LOOT_SALT + 1) % 3 == arrows
                    })
                    .unwrap();
                server.set_time(time - SUNLIGHT_INTERVAL as i64, 6000);
                let mut skeleton = Mob::new(MobKind::Skeleton, pos);
                skeleton.health = SUNLIGHT_DAMAGE;
                server.mobs.insert(id, skeleton);
                server.entities.clear();
                for _ in 1..SUNLIGHT_INTERVAL {
                    server.tick();
                    assert_eq!(server.mobs[&id].health, SUNLIGHT_DAMAGE);
                }
                server.tick();
                assert!(!server.mobs.contains_key(&id));
                let mut drops = BTreeMap::new();
                for drop in server.entities.values() {
                    *drops.entry(drop.item).or_insert(0) += u64::from(drop.count);
                }
                assert_eq!(drops.remove(&bone).unwrap_or(0), bones);
                assert_eq!(drops.remove(&arrow).unwrap_or(0), arrows);
                assert!(drops.is_empty());
            }
        }
    }

    #[test]
    fn zombie_cooldowns_contribute_to_the_state_hash() {
        let (mut server, id) = combat(GameMode::Creative);
        let pos = server.mobs[&id].pos();
        server.mobs.insert(id, Mob::new(MobKind::Zombie, pos));
        let original = server.state_hash();
        let mob = server.mobs.get_mut(&id).unwrap();
        mob.hostile.as_mut().unwrap().attack_ticks = 1;
        let attacking = server.state_hash();
        assert_ne!(attacking, original);
        let mob = server.mobs.get_mut(&id).unwrap();
        mob.hostile.as_mut().unwrap().sunlight_ticks = 1;
        assert_ne!(server.state_hash(), attacking);
    }

    #[test]
    fn reload_restores_persistent_animal_state_before_resuming_ticks() {
        let mut server = Server::new(5, Generator::Flat);
        server.generate_now(0, 0);
        let pos = [2.5, 4.125, 3.5];
        server.spawn_mob(MobKind::Chicken, pos);
        server.spawn_item(1, 5, pos, [0.0; 3], 40);
        let chicken = server.mobs.get_mut(&1).unwrap();
        chicken.body.velocity = [-0.0, -0.25, 0.125];
        chicken.body.on_ground = true;
        chicken.yaw = -0.0;
        chicken.health = 2;
        chicken.age = 234;
        chicken.egg_ticks = Some(901);
        chicken.hurt_ticks = 8;
        chicken.fall_start_y = Some(50.0);
        chicken.suffocation_ticks = 7;
        chicken.lava_ticks = 6;
        chicken.last_dry_pos = [1.0; 3];
        chicken.ai = Wander::Fleeing {
            target: [5.0, 6.0],
            ticks_left: 42,
            blocked: 1,
        };

        server.unload_far_chunks();
        assert!(server.world.chunks.contains_key(&(0, 0)));
        assert_eq!(server.mobs.len(), 1);
        assert_eq!(server.entities.len(), 1);
        let (cx, cz, bytes) = server.take_dirty().unwrap();
        assert!(server.mobs.is_empty());
        assert!(server.entities.is_empty());
        assert!(!server.world.chunks.contains_key(&(0, 0)));

        assert!(server.load_chunk(cx, cz, &bytes));
        let chicken = &server.mobs[&3];
        assert_eq!(chicken.pos(), pos);
        assert_eq!(
            chicken.body.velocity.map(f64::to_bits),
            [-0.0, -0.25, 0.125].map(f64::to_bits)
        );
        assert!(chicken.body.on_ground);
        assert_eq!(chicken.yaw.to_bits(), (-0.0_f32).to_bits());
        assert_eq!(
            (chicken.health, chicken.age, chicken.egg_ticks),
            (2, 234, Some(901))
        );
        assert_eq!(chicken.ai, Wander::Idle);
        assert_eq!(chicken.fall_start_y, Some(pos[1]));
        assert_eq!(chicken.last_dry_pos, pos);
        assert_eq!(
            (
                chicken.hurt_ticks,
                chicken.suffocation_ticks,
                chicken.lava_ticks
            ),
            (0, 0, 0)
        );
        assert_eq!(server.entities[&4].count, 5);
    }

    #[test]
    fn animal_crossing_and_void_despawn_dirty_the_affected_chunks_immediately() {
        let mut server = Server::new(5, Generator::Flat);
        for cx in [0, 1] {
            server.world.insert_chunk(world::Chunk::empty(cx, 0));
        }
        server.spawn_cow([15.8, 80.0, 3.5]);
        let (cx, cz, _) = server.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        server.mobs.get_mut(&1).unwrap().body.velocity[0] = 0.5;

        server.tick();
        assert_eq!(server.mobs[&1].chunk(), (1, 0));
        for expected in [(0, 0), (1, 0)] {
            let (cx, cz, _) = server.take_dirty().unwrap();
            assert_eq!((cx, cz), expected);
        }
        assert!(server.take_dirty().is_none());

        server.mobs.get_mut(&1).unwrap().body.position[1] = VOID_Y - 1.0;
        server.tick();
        assert!(server.mobs.is_empty());
        let (cx, cz, bytes) = server.take_dirty().unwrap();
        assert_eq!((cx, cz), (1, 0));
        assert!(Server::read_saved_chunk(cx, cz, &bytes)
            .unwrap()
            .entities
            .is_empty());
    }

    #[test]
    fn animals_stay_beyond_128_and_despawn_in_missing_chunks_and_below_void() {
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
        server.spawn_mob(MobKind::Zombie, [x + 128.0, y, z]);
        server.spawn_mob(MobKind::Zombie, [x + 129.0, y, z]);
        server.tick_mobs();
        assert_eq!(
            server.mobs.keys().copied().collect::<Vec<_>>(),
            [1, 2, 4, 5]
        );
        server.unload_far_chunks();
        assert_eq!(server.mobs.keys().copied().collect::<Vec<_>>(), [1, 2, 4]);
        let (cx, cz, _) = server.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        assert_eq!(server.mobs.keys().copied().collect::<Vec<_>>(), [1, 2, 4]);
        let (cx, cz, _) = server.take_dirty().unwrap();
        assert_eq!((cx, cz), (8, 0));
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

    fn grounded(kind: MobKind, pos: [f64; 3]) -> Mob {
        let mut mob = Mob::new(kind, pos);
        mob.body.on_ground = true;
        mob
    }

    fn decoded(server: &mut Server) -> Vec<(u32, S2C)> {
        server
            .take_outbox()
            .into_iter()
            .map(|(client, bytes)| (client, S2C::decode(&bytes).unwrap()))
            .collect()
    }

    #[test]
    fn creeper_does_not_burn_and_ignites_only_with_a_close_clear_view() {
        assert!(!spec(MobKind::Creeper).burns_in_sunlight);
        assert!(spec(MobKind::Zombie).burns_in_sunlight);
        let (mut server, id) = combat(GameMode::Creative);
        let pos = server.mobs[&id].pos();
        server.mobs.insert(id, grounded(MobKind::Zombie, pos));
        server.spawn_mob(MobKind::Creeper, [pos[0] + 2.0, pos[1], pos[2]]);
        server.set_time(0, 6000);
        for _ in 0..40 {
            server.tick();
        }
        let creeper = server
            .mobs
            .values()
            .find(|mob| mob.kind == MobKind::Creeper)
            .unwrap();
        assert_eq!(creeper.health, 20);
        assert_eq!(creeper.hostile.as_ref().unwrap().sunlight_ticks, 0);
        assert_eq!(server.mobs[&id].health, 16);

        let world = arena(16);
        let start = [5.5, 1.0, 5.5];
        let mut creeper = grounded(MobKind::Creeper, start);
        creeper.tick(&world, 1, 7, 1, Some([2.5, 1.0, 5.5]));
        assert_eq!(creeper.pos(), start);
        assert_eq!(creeper.yaw, 90.0);
        assert_eq!(creeper.fuse_ticks(), Some(1));
        assert!(!creeper.attacks([2.5, 1.0, 5.5]));

        let mut edge = grounded(MobKind::Creeper, start);
        edge.body.velocity[0] = 0.4;
        edge.hurt_ticks = HURT_TICKS;
        edge.tick(&world, 1, 7, 1, Some([5.5 + 3.0, 1.0, 5.5]));
        assert_eq!(edge.pos(), start);
        assert_eq!(edge.fuse_ticks(), Some(1));

        let mut far = grounded(MobKind::Creeper, start);
        far.tick(&world, 1, 7, 1, Some([5.5 + 3.01, 1.0, 5.5]));
        assert_eq!(far.fuse_ticks(), Some(0));
        assert!(far.pos()[0] > start[0]);

        let mut high = grounded(MobKind::Creeper, start);
        high.tick(&world, 1, 7, 1, Some([8.5, 1.5, 5.5]));
        assert_eq!(high.fuse_ticks(), Some(0));

        let mut cooling = grounded(MobKind::Creeper, start);
        cooling.hostile.as_mut().unwrap().fuse = Some(5);
        cooling.tick(&world, 1, 7, 2, Some([15.5, 1.0, 5.5]));
        assert_eq!(cooling.fuse_ticks(), Some(4));
        assert!(cooling.pos()[0] > start[0]);

        let mut wall = arena(16);
        wall.set_block(4, 2, 5, blocks::STONE);
        let mut hidden = grounded(MobKind::Creeper, start);
        hidden.hostile.as_mut().unwrap().fuse = Some(4);
        hidden.tick(&wall, 1, 7, 3, Some([2.5, 1.0, 5.5]));
        assert_eq!(hidden.fuse_ticks(), Some(3));
        assert!(hidden.pos()[0] < start[0]);
    }

    #[test]
    fn creeper_explodes_at_fuse_30_without_its_own_drop() {
        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        let start = [5.5, 1.0, 5.5];
        server.mobs.insert(id, grounded(MobKind::Creeper, start));
        server.take_outbox();
        for fuse in 1..30 {
            server.tick();
            assert_eq!(server.mobs[&id].fuse_ticks(), Some(fuse));
            assert_eq!(server.mobs[&id].pos(), start);
            assert!(decoded(&mut server).contains(&(1, S2C::MobFuse { id, ticks: fuse })));
        }
        server.tick();
        assert!(!server.mobs.contains_key(&id));
        let gunpowder = items::by_name("gunpowder").unwrap();
        assert!(server.entities.values().all(|drop| drop.item != gunpowder));
        assert!(decoded(&mut server).iter().any(|(_, packet)| {
            matches!(packet, S2C::MobFuse { id: fuse_id, ticks: 30 } if *fuse_id == id)
        }));
    }

    #[test]
    fn explosion_breaks_the_block_ball_except_fluids_bedrock_and_obsidian() {
        let center = [5.5, 1.85, 5.5];
        let mut server = blast_server();
        let mut before = Vec::new();
        for y in 0..6 {
            for z in 0..16 {
                for x in 0..16 {
                    before.push(([x, y, z], server.world.get_block(x, y, z).unwrap()));
                }
            }
        }
        server.apply_explosion(center);
        for ([x, y, z], old) in before {
            let now = server.world.get_block(x, y, z).unwrap();
            let dist = spatial_distance(center, [x as f64 + 0.5, y as f64 + 0.5, z as f64 + 0.5]);
            let wheat = [x, y, z] == [7, 3, 7];
            if dist <= EXPLOSION_BLOCK_RADIUS && !explosion_spares(old) {
                assert_eq!(now, blocks::AIR, "broken {x} {y} {z} dist {dist}");
            } else if wheat {
                assert_eq!(now, blocks::AIR);
            } else {
                assert_eq!(now, old, "kept {x} {y} {z} dist {dist}");
            }
        }
        assert_eq!(server.world.get_block(5, 1, 5), Some(blocks::WATER));
        assert_eq!(server.world.get_block(6, 1, 5), Some(blocks::LAVA));
        assert_eq!(server.world.get_block(4, 1, 5), Some(blocks::FLOWING_WATER));
        assert_eq!(server.world.get_block(5, 2, 5), Some(blocks::OBSIDIAN));
        assert_eq!(server.world.get_block(5, 1, 6), Some(blocks::BEDROCK));
        assert!(server.clients[&1].dig.is_none());
        assert!(!server.furnaces.contains_key(&[6, 1, 6]));
        let coal = items::by_name("coal").unwrap();
        let coal_count: u64 = server
            .entities
            .values()
            .filter(|drop| drop.item == coal)
            .map(|drop| u64::from(drop.count))
            .sum();
        assert_eq!(coal_count, 3);
        assert!(server
            .entities
            .values()
            .any(|drop| drop.item == items::by_name("wheat_seeds").unwrap()));

        let mut dropped = 0;
        let mut kept = 0;
        for x in 0..16 {
            for z in 0..16 {
                let dist = spatial_distance(center, [x as f64 + 0.5, 0.5, z as f64 + 0.5]);
                if dist <= EXPLOSION_BLOCK_RADIUS {
                    if explosion_drops(server.seed, server.game_time, [x, 0, z]) {
                        dropped += 1;
                    } else {
                        kept += 1;
                    }
                }
            }
        }
        assert!(dropped > 0 && kept > 0);
        let cobble = items::by_name("cobblestone").unwrap();
        let cobble_count: u64 = server
            .entities
            .values()
            .filter(|drop| drop.item == cobble)
            .map(|drop| u64::from(drop.count))
            .sum();
        assert_eq!(cobble_count, dropped);

        let mut again = blast_server();
        again.apply_explosion(center);
        let loot = |server: &Server| {
            let mut stacks: Vec<_> = server
                .entities
                .values()
                .map(|drop| (drop.item, drop.count, drop.pos, drop.velocity))
                .collect();
            stacks.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
            stacks
        };
        assert_eq!(loot(&server), loot(&again));
        assert_eq!(server.state_hash(), again.state_hash());

        let mut other_ids = blast_server();
        other_ids.next_entity_id += 100;
        other_ids.apply_explosion(center);
        assert_eq!(loot(&server), loot(&other_ids));
    }

    #[test]
    fn explosion_breaks_blocks_exactly_three_blocks_from_its_center() {
        let (mut server, _) = combat(GameMode::Survival);
        server.apply_explosion([5.5, 0.5, 5.5]);
        assert_eq!(server.world.get_block(8, 0, 5), Some(blocks::AIR));
        assert_eq!(server.world.get_block(8, 0, 6), Some(blocks::STONE));
    }

    #[test]
    fn explosion_starts_a_fall_when_it_breaks_the_support_below_sand() {
        let (mut server, _) = combat(GameMode::Creative);
        server.world.set_block(5, 2, 5, blocks::OBSIDIAN);
        server.world.set_block(5, 3, 5, blocks::STONE);
        server.world.set_block(5, 4, 5, blocks::SAND);
        server.apply_explosion([5.5, 0.5, 5.5]);
        assert_eq!(server.get_block(5, 3, 5), Some(blocks::AIR));
        server.tick();
        assert_eq!(server.get_block(5, 4, 5), Some(blocks::SAND));
        server.tick();
        assert_eq!(server.get_block(5, 4, 5), Some(blocks::AIR));
        assert_eq!(server.get_block(5, 3, 5), Some(blocks::SAND));
    }

    #[test]
    fn explosion_removes_torches_outside_the_blast_when_their_support_breaks() {
        let run = |mode| {
            let (mut server, _) = combat(mode);
            server.world.set_block(5, 3, 5, blocks::STONE);
            server.world.set_block(5, 4, 5, blocks::TORCH);
            server.world.set_block(8, 0, 5, blocks::STONE);
            server.world.set_block(9, 0, 5, blocks::WALL_TORCH + 3);
            server.apply_explosion([5.5, 0.5, 5.5]);
            assert_eq!(server.get_block(5, 3, 5), Some(blocks::AIR));
            assert_eq!(server.get_block(5, 4, 5), Some(blocks::AIR));
            assert_eq!(server.get_block(8, 0, 5), Some(blocks::AIR));
            assert_eq!(server.get_block(9, 0, 5), Some(blocks::AIR));
            let torch = items::by_name("torch").unwrap();
            let drops: Vec<_> = server
                .entities
                .values()
                .filter(|drop| drop.item == torch)
                .collect();
            assert_eq!(drops.len(), if mode == GameMode::Survival { 2 } else { 0 });
            assert!(drops.iter().all(|drop| drop.count == 1));
            server.state_hash()
        };
        assert_eq!(run(GameMode::Survival), run(GameMode::Survival));
        run(GameMode::Creative);
    }

    fn blast_server() -> Server {
        let (mut server, _) = combat(GameMode::Survival);
        server.set_time(10, 18000);
        server.clients.get_mut(&1).unwrap().pos = [5.5, 1.0, 30.5];
        let put = |server: &mut Server, x, y, z, state| {
            assert!(server.world.set_block(x, y, z, state).is_some());
        };
        put(&mut server, 5, 1, 5, blocks::WATER);
        put(&mut server, 6, 1, 5, blocks::LAVA);
        put(&mut server, 4, 1, 5, blocks::FLOWING_WATER);
        put(&mut server, 5, 2, 5, blocks::OBSIDIAN);
        put(&mut server, 5, 1, 6, blocks::BEDROCK);
        put(&mut server, 6, 1, 6, blocks::FURNACE);
        put(&mut server, 7, 2, 7, blocks::FARMLAND);
        put(&mut server, 7, 3, 7, blocks::WHEAT);
        let coal = items::by_name("coal").unwrap();
        server.furnaces.insert(
            [6, 1, 6],
            crate::furnace::Furnace {
                slots: [
                    Some(crate::inventory::Stack {
                        item: coal,
                        count: 3,
                        damage: 0,
                    }),
                    None,
                    None,
                ],
                ..crate::furnace::Furnace::default()
            },
        );
        server.clients.get_mut(&1).unwrap().dig = Some(crate::Dig {
            pos: [5, 0, 5],
            state: blocks::STONE,
            start: 0,
            ticks: 4,
            drops: true,
            stage: Some(1),
        });
        server
    }

    #[test]
    fn explosion_damages_survival_players_and_other_mobs_but_not_creative_or_projectiles() {
        assert_eq!(blast_damage(0.0, 1.0), 15);
        assert_eq!(blast_damage(3.0, 1.0), 7);
        assert_eq!(blast_damage(5.6, 1.0), 1);
        assert_eq!(blast_damage(5.9, 1.0), 0);
        assert_eq!(blast_damage(6.0, 1.0), 0);
        assert_eq!(blast_damage(0.0, 0.0), 0);
        assert_eq!(blast_damage(3.0, 0.5), 3);

        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        let start = [5.5, 1.0, 5.5];
        server.clients.get_mut(&1).unwrap().pos = [8.5, 1.0, 5.5];
        let mut creeper = grounded(MobKind::Creeper, start);
        creeper.hostile.as_mut().unwrap().fuse = Some(29);
        server.mobs.insert(id, creeper);
        server.spawn_cow([7.5, 1.0, 5.5]);
        let cow = server
            .mobs
            .iter()
            .find(|(_, mob)| mob.kind == MobKind::Cow)
            .map(|(&cow, _)| cow)
            .unwrap();
        server.tick();
        assert!(!server.mobs.contains_key(&id));
        assert_eq!(server.clients[&1].health.vitals.health, 13);
        assert!(!server.clients[&1].health.vitals.dead);
        assert_eq!(server.clients[&1].health.vitals.cause, DeathCause::None);
        assert_eq!(server.world.get_block(8, 0, 5), Some(blocks::STONE));
        let cow_mob = &server.mobs[&cow];
        assert_eq!(cow_mob.health, 1);
        assert_eq!(cow_mob.hurt_ticks, HURT_TICKS);
        assert!(matches!(cow_mob.ai, Wander::Fleeing { .. }));
        assert!(decoded(&mut server).iter().any(|(_, packet)| {
            matches!(
                packet,
                S2C::PlayerStatus {
                    health: 13,
                    cause: 0,
                    ..
                }
            )
        }));

        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        server.clients.get_mut(&1).unwrap().pos = [8.5, 1.0, 5.5];
        server.clients.get_mut(&1).unwrap().health.vitals.health = 7;
        hold(&mut server, "raw_beef");
        let mut creeper = grounded(MobKind::Creeper, start);
        creeper.hostile.as_mut().unwrap().fuse = Some(29);
        server.mobs.insert(id, creeper);
        server.tick();
        assert!(server.clients[&1].health.vitals.dead);
        assert_eq!(
            server.clients[&1].health.vitals.cause,
            DeathCause::Explosion
        );
        let beef = items::by_name("raw_beef").unwrap();
        assert!(server.entities.values().any(|drop| drop.item == beef));
        assert!(decoded(&mut server).iter().any(|(_, packet)| {
            matches!(
                packet,
                S2C::PlayerStatus {
                    health: 0,
                    cause: 8,
                    ..
                }
            )
        }));

        let (mut server, cow) = combat(GameMode::Creative);
        server.set_time(0, 18000);
        let pos = server.clients[&1].pos;
        server.spawn_mob(MobKind::Creeper, pos);
        let creeper = server
            .mobs
            .iter()
            .find(|(_, mob)| mob.kind == MobKind::Creeper)
            .map(|(&id, _)| id)
            .unwrap();
        server.tick();
        assert_eq!(server.mobs[&creeper].fuse_ticks(), Some(0));
        let health = server.mobs[&cow].health;
        server.mobs.get_mut(&cow).unwrap().hurt_ticks = 4;
        server.take_outbox();
        server.apply_explosion([pos[0], pos[1] + 0.85, pos[2]]);
        assert_eq!(server.clients[&1].health.vitals.health, 20);
        assert_eq!(server.mobs[&cow].health, health);
        assert!(!decoded(&mut server).contains(&(1, S2C::MobHurt { id: cow })));
        let cow_pos = server.mobs[&cow].pos();
        server.mobs.get_mut(&cow).unwrap().hurt_ticks = 0;
        server.apply_explosion([cow_pos[0], cow_pos[1] + 0.65, cow_pos[2] + 4.0]);
        assert!(server.mobs[&cow].health < health);
        assert_eq!(server.mobs[&cow].hurt_ticks, HURT_TICKS);
        assert_eq!(server.clients[&1].health.vitals.health, 20);

        let (mut server, _) = combat(GameMode::Survival);
        let stick = items::by_name("stick").unwrap();
        server.spawn_item(stick, 1, [5.5, 2.0, 5.5], [0.0, 0.0, 0.0], 40);
        let item = *server.entities.keys().max().unwrap();
        let arrow = crate::arrow::Arrow::aimed([5.5, 3.0, 5.5], [6.5, 3.0, 5.5]);
        server.arrows.insert(u32::MAX, arrow.clone());
        server.apply_explosion([5.5, 1.85, 5.5]);
        assert!(!server.entities.contains_key(&item));
        assert!(server.entities.values().all(|drop| drop.item != stick));
        let cobble = items::by_name("cobblestone").unwrap();
        assert!(server.entities.values().any(|drop| drop.item == cobble));
        assert_eq!(server.arrows[&u32::MAX], arrow);
    }

    fn obsidian_floor(server: &mut Server) {
        for x in 0..16 {
            for z in 0..16 {
                server.world.set_block(x, 0, z, blocks::OBSIDIAN);
            }
        }
    }

    fn player_body(pos: [f64; 3]) -> [f64; 3] {
        [pos[0], pos[1] + PLAYER_BODY_CENTER, pos[2]]
    }

    #[test]
    fn explosion_rays_on_a_face_require_both_adjacent_cubes_to_occlude() {
        for plane in 0..3 {
            let axis = (plane + 1) % 3;
            let mut start = [5.5; 3];
            start[plane] = 5.0;
            let mut end = start;
            end[axis] = 8.5;
            let mut upper = [5; 3];
            upper[axis] = 7;
            let mut lower = upper;
            lower[plane] -= 1;

            let mut world = arena(16);
            let [x, y, z] = upper;
            world.set_block(x, y, z, blocks::STONE);
            assert!(!full_cube_occludes(&world, start, end), "axis {plane}");
            let [x, y, z] = lower;
            world.set_block(x, y, z, blocks::STONE);
            assert!(full_cube_occludes(&world, start, end), "axis {plane}");
            let [x, y, z] = upper;
            world.set_block(x, y, z, blocks::AIR);
            assert!(!full_cube_occludes(&world, start, end), "axis {plane}");
        }
    }

    #[test]
    fn explosion_rays_along_an_edge_require_all_four_cubes_to_occlude() {
        let mut world = arena(16);
        let start = [5.5, 5.0, 5.0];
        let end = [8.5, 5.0, 5.0];
        world.set_block(7, 4, 4, blocks::STONE);
        world.set_block(7, 4, 5, blocks::STONE);
        world.set_block(7, 5, 4, blocks::STONE);
        assert!(!full_cube_occludes(&world, start, end));
        world.set_block(7, 5, 5, blocks::STONE);
        assert!(full_cube_occludes(&world, start, end));
    }

    #[test]
    fn explosion_exposure_counts_a_wall_seam_as_blocked() {
        let mut world = arena(16);
        let center = [5.5, 1.85, 5.0];
        let bounds = Player::new([8.5, 1.0, 5.0]).bounds();
        assert_eq!(blast_exposure(&world, center, bounds), 1.0);
        for y in 1..=3 {
            world.set_block(7, y, 5, blocks::STONE);
        }
        assert_eq!(blast_exposure(&world, center, bounds), 18.0 / 27.0);
        for y in 1..=3 {
            world.set_block(7, y, 4, blocks::STONE);
        }
        assert_eq!(blast_exposure(&world, center, bounds), 0.0);
    }

    #[test]
    fn explosion_exposure_is_full_in_the_open_partial_behind_one_stone_and_zero_behind_a_wall() {
        let center = [5.5, 1.85, 5.5];
        let pos = [8.5, 1.0, 5.5];
        let (mut server, cow_id) = combat(GameMode::Survival);
        server.mobs.remove(&cow_id);
        server.clients.get_mut(&1).unwrap().pos = pos;
        let bounds = Player::new(pos).bounds();
        let body = player_body(pos);
        let distance = spatial_distance(center, body);
        assert_eq!(blast_exposure(&server.world, center, bounds), 1.0);
        assert_eq!(blast_damage(distance, 1.0), 7);

        server.world.set_block(7, 1, 5, blocks::WATER);
        assert_eq!(blast_exposure(&server.world, center, bounds), 1.0);
        server.world.set_block(7, 1, 5, blocks::OAK_SLAB);
        assert_eq!(blast_exposure(&server.world, center, bounds), 1.0);
        server.world.set_block(7, 1, 5, blocks::AIR);

        server.world.set_block(7, 1, 5, blocks::STONE);
        assert_eq!(blast_exposure(&server.world, center, bounds), 9.0 / 27.0);
        assert_eq!(blast_damage(distance, 9.0 / 27.0), 2);
        server.take_outbox();
        server.apply_explosion(center);
        assert_eq!(server.clients[&1].health.vitals.health, 18);
        assert_eq!(server.world.get_block(7, 1, 5), Some(blocks::AIR));
        let knock = knockback_packets(&mut server);
        assert_eq!(
            knock,
            [(1, explosion_velocity(center, body, distance, 9.0 / 27.0))]
        );
        assert!(knock[0].1[0] > 0.0 && knock[0].1[2] == 0.0);

        let (mut server, cow_id) = combat(GameMode::Survival);
        server.mobs.remove(&cow_id);
        server.clients.get_mut(&1).unwrap().pos = pos;
        for x in 6..=7 {
            for y in 1..=4 {
                for z in 4..=7 {
                    server.world.set_block(x, y, z, blocks::STONE);
                }
            }
        }
        let cow = grounded(MobKind::Cow, [8.5, 1.0, 6.2]);
        assert_eq!(
            blast_exposure(&server.world, center, Player::new(pos).bounds()),
            0.0
        );
        assert_eq!(blast_exposure(&server.world, center, cow.bounds()), 0.0);
        server.mobs.insert(cow_id, cow);
        server.take_outbox();
        server.apply_explosion(center);
        assert_eq!(server.clients[&1].health.vitals.health, 20);
        assert_eq!(server.mobs[&cow_id].health, 10);
        assert_eq!(server.mobs[&cow_id].hurt_ticks, 0);
        assert!(knockback_packets(&mut server).is_empty());
        assert_eq!(server.world.get_block(6, 2, 5), Some(blocks::AIR));
        assert_eq!(server.world.get_block(7, 2, 5), Some(blocks::AIR));

        let (mut server, cow_id) = combat(GameMode::Survival);
        server.mobs.remove(&cow_id);
        server.clients.get_mut(&1).unwrap().pos = pos;
        for y in 1..=3 {
            for z in 4..=6 {
                server.world.set_block(7, y, z, blocks::DIRT);
            }
        }
        assert_eq!(
            blast_exposure(&server.world, center, Player::new(pos).bounds()),
            0.0
        );
        server.take_outbox();
        server.apply_explosion(center);
        assert_eq!(server.clients[&1].health.vitals.health, 20);
        assert!(knockback_packets(&mut server).is_empty());
        assert_eq!(server.world.get_block(7, 1, 5), Some(blocks::AIR));
        assert_eq!(server.world.get_block(7, 3, 6), Some(blocks::AIR));
        server.apply_explosion(center);
        assert_eq!(server.clients[&1].health.vitals.health, 13);
    }

    #[test]
    fn explosion_knockback_uses_impact_and_skips_death_creative_and_zero_damage_still_pushes() {
        let origin = [8.0, 1.0, 8.0];
        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        obsidian_floor(&mut server);
        server.clients.get_mut(&1).unwrap().pos = origin;
        let center = player_body(origin);
        server.take_outbox();
        server.apply_explosion(center);
        assert_eq!(server.clients[&1].health.vitals.health, 5);
        assert!(!server.clients[&1].health.vitals.dead);
        assert_eq!(
            knockback_packets(&mut server),
            [(1, [0.0, EXPLOSION_PUSH_VERTICAL, 0.0])]
        );

        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        obsidian_floor(&mut server);
        server.clients.get_mut(&1).unwrap().pos = origin;
        server.clients.get_mut(&1).unwrap().health.vitals.health = 15;
        server.take_outbox();
        server.apply_explosion(player_body(origin));
        assert!(server.clients[&1].health.vitals.dead);
        assert_eq!(
            server.clients[&1].health.vitals.cause,
            DeathCause::Explosion
        );
        assert!(knockback_packets(&mut server).is_empty());

        let (mut server, id) = combat(GameMode::Creative);
        server.mobs.remove(&id);
        obsidian_floor(&mut server);
        server.clients.get_mut(&1).unwrap().pos = origin;
        server.take_outbox();
        server.apply_explosion(player_body(origin));
        assert_eq!(server.clients[&1].health.vitals.health, 20);
        assert!(knockback_packets(&mut server).is_empty());

        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        obsidian_floor(&mut server);
        server.clients.get_mut(&1).unwrap().pos = origin;
        let center = [origin[0] + 5.9, origin[1] + PLAYER_BODY_CENTER, origin[2]];
        let body = player_body(origin);
        let distance = spatial_distance(center, body);
        assert!(distance < EXPLOSION_HURT_RADIUS, "{distance}");
        assert_eq!(
            blast_exposure(&server.world, center, Player::new(origin).bounds()),
            1.0
        );
        assert_eq!(blast_damage(distance, 1.0), 0);
        server.take_outbox();
        server.apply_explosion(center);
        assert_eq!(server.clients[&1].health.vitals.health, 20);
        let velocity = explosion_velocity(center, body, distance, 1.0);
        assert!(velocity[0] < 0.0);
        assert_eq!(velocity[1], 0.0);
        assert_eq!(knockback_packets(&mut server), [(1, velocity)]);
    }

    fn launch_until_landing(server: &mut Server, mut body: Player) -> Player {
        let mut left_ground = !body.on_ground;
        let mut landed = false;
        for _ in 0..40 {
            body.tick(
                Input::default(),
                &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
            );
            left_ground |= !body.on_ground;
            report_knockback_prediction(server, body.position);
            if left_ground && body.on_ground {
                landed = true;
                break;
            }
        }
        assert!(left_ground && landed, "{body:?}");
        body
    }

    #[test]
    fn explosion_knockback_prediction_is_accepted_near_a_wall_and_while_jumping() {
        let origin = [8.0, 1.0, 8.0];
        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        obsidian_floor(&mut server);
        server.clients.get_mut(&1).unwrap().pos = origin;
        server.take_outbox();
        server.apply_explosion(player_body(origin));
        let velocity = knockback_packets(&mut server)[0].1;
        let mut body = Player::new(origin);
        body.on_ground = true;
        body.apply_knockback(
            velocity,
            false,
            &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
        );
        assert_eq!(body.velocity[1], 0.4);
        let landed = launch_until_landing(&mut server, body);
        assert_eq!(landed.position[0], origin[0]);
        assert_eq!(landed.position[2], origin[2]);
        assert_eq!(landed.position[1], origin[1]);

        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        obsidian_floor(&mut server);
        for y in 1..=3 {
            for z in 7..=9 {
                server.world.set_block(6, y, z, blocks::OBSIDIAN);
            }
        }
        server.clients.get_mut(&1).unwrap().pos = origin;
        let center = [10.5, 1.2, 8.0];
        assert_eq!(
            blast_exposure(&server.world, center, Player::new(origin).bounds()),
            1.0
        );
        server.take_outbox();
        server.apply_explosion(center);
        let velocity = knockback_packets(&mut server)[0].1;
        assert!(velocity[0] < 0.0, "{velocity:?}");
        let mut body = Player::new(origin);
        body.on_ground = true;
        body.apply_knockback(
            velocity,
            false,
            &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
        );
        let landed = launch_until_landing(&mut server, body);
        assert!(
            landed.position[0] - physics::WIDTH / 2.0 >= 7.0 - 1e-6,
            "entered the wall: {landed:?}"
        );
        assert!(landed.position[0] < origin[0], "{landed:?}");

        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        obsidian_floor(&mut server);
        server.clients.get_mut(&1).unwrap().pos = origin;
        let center = [origin[0] + 1.2, origin[1] + PLAYER_BODY_CENTER, origin[2]];
        server.take_outbox();
        server.apply_explosion(center);
        let velocity = knockback_packets(&mut server)[0].1;
        assert!(velocity[0] < 0.0, "{velocity:?}");
        let mut body = Player::new(origin);
        body.on_ground = true;
        body.tick(
            Input {
                jump: true,
                ..Input::default()
            },
            &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
        );
        assert!(!body.on_ground);
        report_knockback_prediction(&mut server, body.position);
        let vy = body.velocity[1];
        body.apply_knockback(
            velocity,
            false,
            &physics::BlockWorld(|x, y, z| server.world.get_block(x, y, z)),
        );
        assert_eq!(body.velocity[1], vy);
        let landed = launch_until_landing(&mut server, body);
        assert!(origin[0] - landed.position[0] > 0.2, "{landed:?}");
        assert_eq!(landed.position[1], origin[1]);
    }

    #[test]
    fn explosion_keeps_loot_from_the_cow_it_kills_but_removes_existing_exposed_drops() {
        let (mut server, cow_id) = combat(GameMode::Survival);
        let center = [5.5, 1.85, 5.5];
        let cow = grounded(MobKind::Cow, [6.5, 1.0, 5.5]);
        assert_eq!(blast_exposure(&server.world, center, cow.bounds()), 1.0);
        server.mobs.insert(cow_id, cow);
        let stick = items::by_name("stick").unwrap();
        let existing = server.next_entity_id;
        server.spawn_item(stick, 1, [5.5, 2.0, 6.5], [0.0; 3], 40);
        assert_eq!(
            blast_exposure(&server.world, center, server.entities[&existing].bounds()),
            1.0
        );

        server.apply_explosion(center);

        assert!(!server.mobs.contains_key(&cow_id));
        assert!(!server.entities.contains_key(&existing));
        let beef = items::by_name("raw_beef").unwrap();
        assert!(server.entities.values().any(|drop| drop.item == beef));
    }

    #[test]
    fn explosion_removes_exposed_drops_and_keeps_sheltered_items_arrows_and_blast_loot() {
        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        let center = [5.5, 1.85, 5.5];
        let stick = items::by_name("stick").unwrap();
        let beef = items::by_name("raw_beef").unwrap();
        let powder = items::by_name("gunpowder").unwrap();
        for x in 6..=7 {
            for y in 1..=3 {
                for z in 4..=6 {
                    server.world.set_block(x, y, z, blocks::STONE);
                }
            }
        }
        let exposed = server.next_entity_id;
        server.spawn_item(stick, 1, [5.5, 2.0, 5.5], [0.0; 3], 40);
        let sheltered_pos = [8.5, 1.2, 5.5];
        let sheltered = server.next_entity_id;
        server.spawn_item(beef, 1, sheltered_pos, [0.0; 3], 40);
        assert_eq!(
            blast_exposure(&server.world, center, server.entities[&sheltered].bounds()),
            0.0
        );
        let far = server.next_entity_id;
        server.spawn_item(powder, 1, [5.5, 1.0, 14.0], [0.0; 3], 40);
        let arrow = crate::arrow::Arrow::aimed([5.5, 3.0, 5.5], [6.5, 3.0, 5.5]);
        server.arrows.insert(u32::MAX, arrow.clone());
        server.sync_entities();
        server.take_outbox();
        server.apply_explosion(center);
        assert!(!server.entities.contains_key(&exposed));
        assert!(server.entities.values().all(|drop| drop.item != stick));
        assert_eq!(server.entities[&sheltered].item, beef);
        assert_eq!(server.entities[&sheltered].pos, sheltered_pos);
        assert_eq!(server.entities[&far].item, powder);
        assert_eq!(server.arrows[&u32::MAX], arrow);
        let cobble = items::by_name("cobblestone").unwrap();
        assert!(server.entities.values().any(|drop| drop.item == cobble));
        server.sync_entities();
        let removed: Vec<_> = decoded(&mut server)
            .into_iter()
            .filter_map(|(client, packet)| match packet {
                S2C::EntityRemove { id } => Some((client, id)),
                _ => None,
            })
            .collect();
        assert!(removed.contains(&(1, exposed)));
        assert!(removed.iter().all(|(_, id)| *id != sheltered && *id != far));

        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        while server.take_dirty().is_some() {}
        let high = [8.0, 40.0, 8.0];
        let item = server.next_entity_id;
        server.spawn_item(stick, 1, high, [0.0; 3], 40);
        while server.take_dirty().is_some() {}
        server.apply_explosion(high);
        assert!(!server.entities.contains_key(&item));
        assert_eq!(
            server.take_dirty().map(|(cx, cz, _)| (cx, cz)),
            Some((0, 0))
        );

        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        server.set_entity_persistence(false);
        while server.take_dirty().is_some() {}
        let item = server.next_entity_id;
        server.spawn_item(stick, 1, high, [0.0; 3], 40);
        server.apply_explosion(high);
        assert!(!server.entities.contains_key(&item));
        assert_eq!(server.take_dirty(), None);
    }

    #[test]
    fn explosion_packet_reaches_only_joined_clients_with_the_center_chunk() {
        let (mut server, id) = combat(GameMode::Survival);
        server.mobs.remove(&id);
        assert!(server.clients[&1].sent.contains(&(0, 0)));
        server.connect(2);
        server.clients.get_mut(&2).unwrap().joined = true;
        server.connect(3);
        {
            let client = server.clients.get_mut(&3).unwrap();
            client.joined = true;
            client.sent.insert((1, 0));
        }
        server.connect(4);
        server.clients.get_mut(&4).unwrap().sent.insert((0, 0));
        server.take_outbox();
        let center = [5.5, 1.85, 5.5];
        server.apply_explosion(center);
        let explosions: Vec<_> = decoded(&mut server)
            .into_iter()
            .filter_map(|(client, packet)| match packet {
                S2C::Explosion { center: got } => Some((client, got)),
                _ => None,
            })
            .collect();
        assert_eq!(explosions, vec![(1, center)]);
    }

    #[test]
    fn creeper_fuse_changes_only_the_creeper_state_hash_and_replays() {
        let (mut server, id) = combat(GameMode::Survival);
        let pos = server.mobs[&id].pos();
        server.mobs.insert(id, Mob::new(MobKind::Creeper, pos));
        let hash = server.state_hash();
        server
            .mobs
            .get_mut(&id)
            .unwrap()
            .hostile
            .as_mut()
            .unwrap()
            .fuse = Some(1);
        assert_ne!(server.state_hash(), hash);
        server
            .mobs
            .get_mut(&id)
            .unwrap()
            .hostile
            .as_mut()
            .unwrap()
            .fuse = Some(0);
        assert_eq!(server.state_hash(), hash);

        let run = || {
            let (mut server, id) = combat(GameMode::Survival);
            server.set_time(4, 18000);
            server.clients.get_mut(&1).unwrap().pos = [8.5, 1.0, 5.5];
            let mut creeper = grounded(MobKind::Creeper, [5.5, 1.0, 5.5]);
            creeper.hostile.as_mut().unwrap().fuse = Some(29);
            server.mobs.insert(id, creeper);
            server.tick();
            let mut blocks = Vec::new();
            for x in 4..9 {
                blocks.push(server.world.get_block(x, 0, 5));
            }
            (
                server.state_hash(),
                server.clients[&1].health.vitals,
                blocks,
                server.mobs.contains_key(&id),
            )
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn four_mixed_hostiles_fill_the_shared_cap() {
        let mut server = joined(GameMode::Survival);
        let pos = server.clients[&1].pos;
        for kind in [
            MobKind::Zombie,
            MobKind::Skeleton,
            MobKind::Creeper,
            MobKind::Zombie,
        ] {
            server.spawn_mob(kind, pos);
        }
        let before = server.mobs.len();
        server.game_time = 200;
        server.spawn_hostile(1, pos, &[(1, pos)]);
        assert_eq!(server.mobs.len(), before);
        assert_eq!(
            server
                .mobs
                .values()
                .filter(|mob| mob.hostile.is_some())
                .count(),
            4
        );
    }

    #[test]
    fn fuse_is_sent_again_when_a_lit_creeper_becomes_visible() {
        let (mut server, id) = combat(GameMode::Survival);
        server.set_time(0, 18000);
        let mut creeper = grounded(MobKind::Creeper, [5.5, 1.0, 5.5]);
        creeper.hostile.as_mut().unwrap().fuse = Some(4);
        server.mobs.insert(id, creeper);
        server.clients.get_mut(&1).unwrap().visible_mobs.clear();
        server.sync_mobs();
        let packets = decoded(&mut server);
        assert!(packets.iter().any(|(_, packet)| matches!(
            packet,
            S2C::MobSpawn {
                kind: MobKind::Creeper,
                ..
            }
        )));
        assert!(packets.iter().any(|(_, packet)| {
            matches!(packet, S2C::MobFuse { id: fuse_id, ticks: 4 } if *fuse_id == id)
        }));
    }

    fn ring_column(roll: u64, pos: [f64; 3]) -> (i32, i32) {
        let [dx, dz] = direction(roll);
        let radius = 24.75 + ((roll >> 16) % 2251) as f64 / 100.0;
        (
            (pos[0] + dx * radius).floor() as i32,
            (pos[2] + dz * radius).floor() as i32,
        )
    }

    fn column_in_ring(pos: [f64; 3], x: i32, z: i32) -> bool {
        let center = [f64::from(x) + 0.5, 0.0, f64::from(z) + 0.5];
        (24.0 * 24.0..=48.0 * 48.0).contains(&distance_squared(pos, center))
    }

    fn dark_start_y(roll: u64, pos: [f64; 3]) -> i32 {
        pos[1].floor() as i32 + ((roll >> 32) % 33) as i32 - 16
    }

    fn tick_spawn(server: &mut Server, time: i64, day: i64) {
        server.mobs.clear();
        server.set_time(time - 1, day - 1);
        server.tick();
    }

    fn hostiles(server: &Server) -> Vec<(MobKind, [f64; 3])> {
        server
            .mobs
            .values()
            .filter(|mob| mob.hostile.is_some())
            .map(|mob| (mob.kind, mob.pos()))
            .collect()
    }

    fn seal_dark_room(world: &mut World, x: i32, floor: i32, z: i32) {
        for dz in -2i32..=2 {
            for dx in -2i32..=2 {
                for dy in 0i32..=3 {
                    let state = if (1..=2).contains(&dy) && dx.abs() <= 1 && dz.abs() <= 1 {
                        blocks::AIR
                    } else {
                        blocks::STONE
                    };
                    assert!(
                        world.set_block(x + dx, floor + dy, z + dz, state).is_some(),
                        "unloaded {}, {dy}, {}",
                        x + dx,
                        z + dz
                    );
                }
            }
        }
    }

    fn column_would_dark_spawn(world: &World, id: u32, time: i64, pos: [f64; 3]) -> bool {
        let roll = sample(2026, id, time, HOSTILE_DARK_COLUMN_SALT);
        let (x, z) = ring_column(roll, pos);
        if !column_in_ring(pos, x, z) {
            return false;
        }
        let Some(candidate) = hostile_dark_feet(world, x, z, dark_start_y(roll, pos)) else {
            return false;
        };
        if !(24.0 * 24.0..=48.0 * 48.0).contains(&distance_squared(pos, candidate)) {
            return false;
        }
        let feet = [x, candidate[1] as i32, z];
        world.local_sky_light(feet) == 0 && world.local_block_light(feet) == 0
    }

    fn join_at(server: &mut Server, id: u32, pos: [f64; 3]) {
        server.connect_at(id, false, Some(pos), None);
        server.handle_packet(
            id,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
    }

    #[test]
    fn dark_feet_search_skips_partial_blocks_and_stops_after_sixteen() {
        let mut world = World::new();
        world.chunks.insert((0, 0), Chunk::empty(0, 0));
        world.set_block(4, 20, 4, blocks::OAK_LEAVES);
        world.set_block(4, 18, 4, blocks::OAK_SLAB);
        assert_eq!(hostile_dark_feet(&world, 4, 4, 20), None);
        world.set_block(4, 14, 4, blocks::STONE);
        assert_eq!(hostile_dark_feet(&world, 4, 4, 20), Some([4.5, 15.0, 4.5]));
        world.set_block(4, 15, 4, blocks::WATER);
        assert_eq!(hostile_dark_feet(&world, 4, 4, 20), None);
        world.set_block(4, 15, 4, blocks::AIR);
        world.set_block(4, 14, 4, blocks::GLASS);
        assert_eq!(hostile_dark_feet(&world, 4, 4, 20), Some([4.5, 15.0, 4.5]));
        world.set_block(4, 14, 4, blocks::AIR);
        world.set_block(6, 20 - 15, 6, blocks::STONE);
        assert_eq!(
            hostile_dark_feet(&world, 6, 6, 20),
            Some([6.5, f64::from(20 - 15 + 1), 6.5])
        );
        world.set_block(6, 20 - 15, 6, blocks::AIR);
        world.set_block(6, 20 - 16, 6, blocks::STONE);
        assert_eq!(hostile_dark_feet(&world, 6, 6, 20), None);

        let top = MIN_Y + HEIGHT - 1;
        world.set_block(4, top - 2, 4, blocks::STONE);
        assert_eq!(
            hostile_dark_feet(&world, 4, 4, top + 4),
            Some([4.5, f64::from(top - 1), 4.5])
        );
        assert_eq!(hostile_dark_feet(&world, 4, 4, MIN_Y - 4), None);
        assert_eq!(hostile_dark_feet(&world, 32, 4, 20), None);
    }

    #[test]
    fn dark_hostiles_spawn_by_day_only_under_unlit_cover() {
        let mut server = joined(GameMode::Creative);
        assert!(!server.world.lighting_enabled());
        let pos = server.clients[&1].pos;
        let (time, x, floor, z) = (200..40_000)
            .step_by(200)
            .filter(|time| time % 400 != 0)
            .find_map(|time| {
                let roll = sample(2026, 1, time, HOSTILE_DARK_COLUMN_SALT);
                let (x, z) = ring_column(roll, pos);
                let floor = dark_start_y(roll, pos);
                if !column_in_ring(pos, x, z) || !(-60..=-46).contains(&floor) {
                    return None;
                }
                let natural = hostile_dark_feet(&server.world, x, z, floor)?;
                let sky = server.world.local_sky_light([x, natural[1] as i32, z]);
                (sky > 0).then_some((time, x, floor, z))
            })
            .expect("daytime dark column");

        tick_spawn(&mut server, time, 6000);
        assert!(hostiles(&server).is_empty(), "open ground spawns by day");

        seal_dark_room(&mut server.world, x, floor, z);
        let feet = [x, floor + 1, z];
        assert_eq!(server.world.local_sky_light(feet), 0);
        assert_eq!(server.world.local_block_light(feet), 0);
        tick_spawn(&mut server, time, 6000);
        let spawned = hostiles(&server);
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0].0, hostile_dark_kind(2026, 1, time));
        assert!(column_in_ring(pos, x, z));
        assert!((24.0 * 24.0..=48.0 * 48.0).contains(&distance_squared(spawned[0].1, pos)));
        let [mx, _, mz] = spawned[0].1.map(|v| v.floor() as i32);
        assert_eq!((mx, mz), (x, z));
        let health = server.mobs.values().next().unwrap().health;
        for _ in 0..20 {
            server.tick();
        }
        assert_eq!(server.mobs.values().next().unwrap().health, health);
        assert_eq!(hostiles(&server).len(), 1);

        server.world.set_block(x + 2, floor + 1, z, blocks::AIR);
        server.world.set_block(x + 2, floor + 2, z, blocks::AIR);
        assert!(server.world.local_sky_light(feet) > 0);
        tick_spawn(&mut server, time, 6000);
        assert!(
            hostiles(&server).is_empty(),
            "sky light from the entrance still spawns"
        );

        server.world.set_block(x + 2, floor + 1, z, blocks::STONE);
        server.world.set_block(x + 2, floor + 2, z, blocks::STONE);
        server.world.set_block(x + 2, floor + 1, z, blocks::AIR);
        for dz in -1..=1 {
            for dy in 0..=2 {
                server
                    .world
                    .set_block(x + 3, floor + dy, z + dz, blocks::STONE);
            }
        }
        server.world.set_block(x + 4, floor + 1, z, blocks::STONE);
        server.world.set_block(x + 3, floor + 1, z, blocks::TORCH);
        assert_eq!(server.world.local_sky_light(feet), 0);
        assert!(server.world.local_block_light(feet) > 0);
        tick_spawn(&mut server, time, 6000);
        assert!(hostiles(&server).is_empty(), "torch still spawns");

        server.world.set_block(x + 3, floor + 1, z, blocks::STONE);
        server.world.set_block(x + 2, floor + 1, z, blocks::STONE);
        assert_eq!(server.world.local_block_light(feet), 0);
        tick_spawn(&mut server, time, 6000);
        assert_eq!(hostiles(&server).len(), 1);

        server.mobs.clear();
        for _ in 0..8 {
            server.spawn_mob(MobKind::Cow, pos);
        }
        server.set_time(time - 1, 5999);
        server.tick();
        assert_eq!(hostiles(&server).len(), 1);
        assert_eq!(server.mobs.len(), 9);

        server.mobs.clear();
        for _ in 0..HOSTILE_LOCAL_LIMIT {
            server.spawn_mob(MobKind::Zombie, pos);
        }
        server.set_time(time - 1, 5999);
        server.tick();
        assert_eq!(hostiles(&server).len(), HOSTILE_LOCAL_LIMIT);
        server.mobs.pop_first();
        server.set_time(time - 1, 5999);
        server.tick();
        assert_eq!(hostiles(&server).len(), HOSTILE_LOCAL_LIMIT);
        assert!(hostiles(&server).iter().any(|(_, p)| {
            let [hx, _, hz] = p.map(|v| v.floor() as i32);
            (hx, hz) == (x, z)
        }));

        let blocked = [f64::from(x) + 0.5, f64::from(floor + 1), f64::from(z) + 0.5];
        assert!(!column_would_dark_spawn(&server.world, 2, time, blocked));
        join_at(&mut server, 2, blocked);
        tick_spawn(&mut server, time, 6000);
        assert!(hostiles(&server).is_empty(), "nearby player still spawns");

        let edge = [(24, 0), (-24, 0), (0, 24), (0, -24)]
            .into_iter()
            .map(|(dx, dz)| {
                [
                    blocked[0] + f64::from(dx),
                    blocked[1],
                    blocked[2] + f64::from(dz),
                ]
            })
            .find(|pos| !column_would_dark_spawn(&server.world, 2, time, *pos))
            .expect("observer at 24 blocks");
        server.clients.get_mut(&2).unwrap().pos = edge;
        tick_spawn(&mut server, time, 6000);
        assert!(hostiles(&server).is_empty(), "24 blocks away still spawns");

        server.clients.get_mut(&2).unwrap().pos = [blocked[0] + 200.0, blocked[1], blocked[2]];
        tick_spawn(&mut server, time, 6000);
        let far = hostiles(&server);
        assert_eq!(far.len(), 1);
        assert_eq!(far[0].0, hostile_dark_kind(2026, 1, time));
    }

    #[test]
    fn dark_and_surface_spawns_share_the_cap_and_use_separate_kinds() {
        let mut server = joined(GameMode::Creative);
        let pos = server.clients[&1].pos;
        let (time, x, floor, z, sx, sz) = (200..80_000)
            .step_by(200)
            .filter(|time| time % 400 != 0)
            .find_map(|time| {
                let roll = sample(2026, 1, time, HOSTILE_DARK_COLUMN_SALT);
                let (x, z) = ring_column(roll, pos);
                let floor = dark_start_y(roll, pos);
                if !column_in_ring(pos, x, z) || !(-60..=-46).contains(&floor) {
                    return None;
                }
                let surface = sample(2026, 1, time, HOSTILE_COLUMN_SALT);
                let (sx, sz) = ring_column(surface, pos);
                if !column_in_ring(pos, sx, sz) {
                    return None;
                }
                if (sx - x).abs().max((sz - z).abs()) <= 6 {
                    return None;
                }
                if hostile_kind(2026, 1, time) == hostile_dark_kind(2026, 1, time) {
                    return None;
                }
                Some((time, x, floor, z, sx, sz))
            })
            .expect("split night column");

        seal_dark_room(&mut server.world, x, floor, z);
        tick_spawn(&mut server, time, 18000);
        let spawned = hostiles(&server);
        assert_eq!(spawned.len(), 2, "{spawned:?}");
        let dark_at = |p: [f64; 3]| {
            let [hx, _, hz] = p.map(|v| v.floor() as i32);
            (hx, hz) == (x, z)
        };
        let surface_at = |p: [f64; 3]| {
            let [hx, _, hz] = p.map(|v| v.floor() as i32);
            (hx, hz) == (sx, sz)
        };
        let dark = spawned.iter().find(|(_, p)| dark_at(*p)).expect("dark mob");
        let surface = spawned
            .iter()
            .find(|(_, p)| surface_at(*p))
            .expect("surface mob");
        assert_eq!(dark.0, hostile_dark_kind(2026, 1, time));
        assert_eq!(surface.0, hostile_kind(2026, 1, time));
        assert_ne!(dark.0, surface.0);

        server.mobs.clear();
        for _ in 0..HOSTILE_LOCAL_LIMIT - 1 {
            server.spawn_mob(MobKind::Zombie, pos);
        }
        server.set_time(time - 1, 17999);
        server.tick();
        assert_eq!(hostiles(&server).len(), HOSTILE_LOCAL_LIMIT);
        assert!(hostiles(&server).iter().any(|(_, p)| surface_at(*p)));
        assert!(hostiles(&server).iter().all(|(_, p)| !dark_at(*p)));
    }
}
