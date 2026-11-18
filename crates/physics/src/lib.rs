//! Deterministic, sans-I/O player movement. Positions are feet, velocities are
//! blocks/tick, yaw is degrees (0 = +Z, 90 = -X). See docs/physics.md for the model.
use jmath::sin_table::{cos, sin};

pub const WIDTH: f64 = 0.6_f32 as f64;
pub const HEIGHT: f64 = 1.8_f32 as f64;
pub const EYE_HEIGHT: f64 = 1.62;
pub const STEP_HEIGHT: f64 = 0.6_f32 as f64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}
impl Aabb {
    pub fn block(x: i32, y: i32, z: i32) -> Self {
        Self {
            min: [x as f64, y as f64, z as f64],
            max: [(x + 1) as f64, (y + 1) as f64, (z + 1) as f64],
        }
    }
    pub fn translated(mut self, delta: [f64; 3]) -> Self {
        for (axis, d) in delta.into_iter().enumerate() {
            self.min[axis] += d;
            self.max[axis] += d;
        }
        self
    }
    pub fn intersects(self, other: Self) -> bool {
        (0..3).all(|a| self.max[a] > other.min[a] && self.min[a] < other.max[a])
    }
}

/// Enumerate boxes owned by one cell; fences can extend 0.5 blocks above it.
pub trait CollisionWorld {
    fn collision_boxes(&self, x: i32, y: i32, z: i32, visit: &mut dyn FnMut(Aabb));
}
/// Convenience adapter for simple worlds with at most one box.
impl<F: Fn(i32, i32, i32) -> Option<Aabb>> CollisionWorld for F {
    fn collision_boxes(&self, x: i32, y: i32, z: i32, visit: &mut dyn FnMut(Aabb)) {
        if let Some(b) = self(x, y, z) {
            visit(b);
        }
    }
}
pub fn shape_box(bounds: world::blocks::Box16, x: i32, y: i32, z: i32) -> Aabb {
    let cell = [x, y, z];
    Aabb {
        min: std::array::from_fn(|a| cell[a] as f64 + bounds.min[a] as f64 / 16.0),
        max: std::array::from_fn(|a| cell[a] as f64 + bounds.max[a] as f64 / 16.0),
    }
}
/// Registry collision adapter shared by client prediction and server sweeps.
pub struct BlockWorld<F>(pub F);
impl<F: Fn(i32, i32, i32) -> Option<u16>> CollisionWorld for BlockWorld<F> {
    fn collision_boxes(&self, x: i32, y: i32, z: i32, visit: &mut dyn FnMut(Aabb)) {
        match self.0(x, y, z) {
            None => visit(Aabb::block(x, y, z)),
            Some(state) => {
                world::blocks::shape_boxes(
                    state,
                    |dx, dy, dz| self.0(x + dx, y + dy, z + dz).unwrap_or(world::blocks::AIR),
                    world::blocks::ShapePurpose::Collision,
                    |bounds| visit(shape_box(bounds, x, y, z)),
                );
            }
        }
    }
}
/// Per-box escape filtering preserves overlapping-placement behaviour.
pub struct EscapeWorld<'a, W>(pub &'a W, pub Aabb);
impl<W: CollisionWorld> CollisionWorld for EscapeWorld<'_, W> {
    fn collision_boxes(&self, x: i32, y: i32, z: i32, visit: &mut dyn FnMut(Aabb)) {
        self.0.collision_boxes(x, y, z, &mut |b| {
            if !self.1.intersects(b) {
                visit(b);
            }
        });
    }
}

/// Ray/box intersection, returning distance and Direction face. Parallel rays
/// outside a slab miss; an origin inside a box selects its exit face.
pub fn ray_box(origin: [f64; 3], dir: [f64; 3], bounds: Aabb) -> Option<(f64, i32)> {
    let mut near = f64::NEG_INFINITY;
    let mut far = f64::INFINITY;
    let mut enter = -1;
    let mut exit = -1;
    for (axis, faces) in [[4, 5], [0, 1], [2, 3]].iter().enumerate() {
        if dir[axis] == 0.0 {
            if origin[axis] < bounds.min[axis] || origin[axis] > bounds.max[axis] {
                return None;
            }
            continue;
        }
        let a = (bounds.min[axis] - origin[axis]) / dir[axis];
        let b = (bounds.max[axis] - origin[axis]) / dir[axis];
        let positive = dir[axis] > 0.0;
        if a.min(b) > near {
            near = a.min(b);
            enter = faces[usize::from(!positive)];
        }
        if a.max(b) < far {
            far = a.max(b);
            exit = faces[usize::from(positive)];
        }
        if near > far {
            return None;
        }
    }
    if far < 0.0 {
        None
    } else if near >= 0.0 {
        Some((near, enter))
    } else {
        Some((far, exit))
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    pub forward: f32,
    /// Positive is right.
    pub strafe: f32,
    pub jump: bool,
    pub sprint: bool,
    pub sneak: bool,
    pub flying: bool,
    pub yaw: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Player {
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    pub on_ground: bool,
    jump_cooldown: u8,
}
impl Player {
    pub fn new(position: [f64; 3]) -> Self {
        Self {
            position,
            ..Self::default()
        }
    }
    pub fn bounds(&self) -> Aabb {
        let [x, y, z] = self.position;
        Aabb {
            min: [x - WIDTH / 2.0, y, z - WIDTH / 2.0],
            max: [x + WIDTH / 2.0, y + HEIGHT, z + WIDTH / 2.0],
        }
    }
    pub fn is_clear(&self, world: &impl CollisionWorld) -> bool {
        !occupied(world, self.bounds())
    }
    /// Checks the footprint immediately below the feet with prediction's
    /// collision boxes. Boxes intersecting the player's sides are not support.
    pub fn is_grounded(&self, world: &impl CollisionWorld) -> bool {
        const GROUND_PROBE: f64 = 0.001;
        let mut probe = self.bounds();
        let feet = probe.min[1];
        probe.min[1] = feet - GROUND_PROBE;
        probe.max[1] = feet;
        let mut grounded = false;
        visit(world, probe, |b| {
            grounded |= b.max[1] <= feet && probe.intersects(b)
        });
        grounded
    }
    pub fn tick(&mut self, input: Input, world: &impl CollisionWorld) {
        let grounded = self.on_ground;
        let sprint = input.sprint && (input.flying || !input.sneak);
        let friction = if grounded && !input.flying {
            0.6_f32 * 0.91_f32
        } else {
            0.91_f32
        };
        for v in &mut self.velocity {
            if v.abs() < 0.003 {
                *v = 0.0;
            }
        }
        self.jump_cooldown = self.jump_cooldown.saturating_sub(1);
        if !input.jump {
            self.jump_cooldown = 0;
        }
        let yaw = input.yaw * (std::f32::consts::PI / 180.0);
        if input.flying {
            let vertical = i32::from(input.jump) - i32::from(input.sneak);
            self.velocity[1] += (vertical as f32 * 0.05_f32 * 3.0_f32) as f64;
        } else if input.jump && grounded && self.jump_cooldown == 0 {
            self.velocity[1] = 0.42_f32 as f64;
            if sprint {
                self.velocity[0] -= (sin(yaw) * 0.2_f32) as f64;
                self.velocity[2] += (cos(yaw) * 0.2_f32) as f64;
            }
            self.jump_cooldown = 10;
        }
        let speed = if input.flying {
            if sprint {
                0.1_f32
            } else {
                0.05_f32
            }
        } else if grounded {
            let movement = if sprint {
                (0.1_f64 * 1.3) as f32
            } else {
                0.1_f32
            };
            movement * (0.162_771_36_f32 / (friction * friction * friction))
        } else if sprint {
            0.026_f32
        } else {
            0.02_f32
        };
        let sneak = if input.sneak && !input.flying {
            0.3_f32
        } else {
            1.0_f32
        };
        let mut f = input.forward.clamp(-1.0, 1.0) * sneak * 0.98_f32;
        let mut s = input.strafe.clamp(-1.0, 1.0) * sneak * 0.98_f32;
        let length = s * s + f * f;
        if length >= 1.0e-4_f32 {
            let divisor = length.sqrt().max(1.0);
            f *= speed / divisor;
            s *= speed / divisor;
            self.velocity[0] += (-s * cos(yaw) - f * sin(yaw)) as f64;
            self.velocity[2] += (f * cos(yaw) - s * sin(yaw)) as f64;
        }
        let bounds = self.bounds();
        let mut desired = self.velocity;
        if input.sneak && grounded && !input.flying {
            for axis in [0, 2] {
                while desired[axis] != 0.0
                    && !supported(
                        world,
                        bounds,
                        if axis == 0 { desired[0] } else { 0.0 },
                        if axis == 2 { desired[2] } else { 0.0 },
                    )
                {
                    desired[axis] = toward_zero(desired[axis]);
                }
            }
            while desired[0] != 0.0
                && desired[2] != 0.0
                && !supported(world, bounds, desired[0], desired[2])
            {
                desired[0] = toward_zero(desired[0]);
                desired[2] = toward_zero(desired[2]);
            }
        }
        let mut actual = resolve(world, bounds, desired);
        if !input.flying
            && (grounded || desired[1] < 0.0 && actual[1] != desired[1])
            && (actual[0] != desired[0] || actual[2] != desired[2])
        {
            let up = resolve(world, bounds, [0.0, STEP_HEIGHT, 0.0])[1];
            let raised = bounds.translated([0.0, up, 0.0]);
            let across = resolve(world, raised, [desired[0], 0.0, desired[2]]);
            let down = resolve(
                world,
                raised.translated(across),
                [0.0, desired[1] - up, 0.0],
            )[1];
            if across[0] * across[0] + across[2] * across[2]
                > actual[0] * actual[0] + actual[2] * actual[2]
            {
                actual = [across[0], up + down, across[2]];
            }
        }
        self.on_ground = desired[1] < 0.0 && actual[1] != desired[1];
        for axis in 0..3 {
            self.position[axis] += actual[axis];
            if actual[axis] != desired[axis] {
                self.velocity[axis] = 0.0;
            }
        }
        self.velocity[0] *= friction as f64;
        self.velocity[2] *= friction as f64;
        if input.flying {
            self.velocity[1] *= 0.6_f64;
        } else {
            self.velocity[1] = (self.velocity[1] - 0.08_f64) * 0.98_f32 as f64;
        }
    }
}

fn toward_zero(v: f64) -> f64 {
    if v.abs() <= 0.05 {
        0.0
    } else {
        v - v.signum() * 0.05
    }
}
fn visit(world: &impl CollisionWorld, region: Aabb, mut callback: impl FnMut(Aabb)) {
    // Fence boxes extend above their owner cell, including when feet are airborne.
    for y in region.min[1].floor() as i32 - 1..region.max[1].ceil() as i32 {
        for x in region.min[0].floor() as i32..region.max[0].ceil() as i32 {
            for z in region.min[2].floor() as i32..region.max[2].ceil() as i32 {
                world.collision_boxes(x, y, z, &mut callback);
            }
        }
    }
}
fn occupied(world: &impl CollisionWorld, bounds: Aabb) -> bool {
    let mut hit = false;
    visit(world, bounds, |b| hit |= bounds.intersects(b));
    hit
}
fn supported(world: &impl CollisionWorld, bounds: Aabb, x: f64, z: f64) -> bool {
    occupied(world, bounds.translated([x, -STEP_HEIGHT, z]))
}
/// Sweep an AABB using the same Y/X/Z clipping as player prediction.
pub fn resolve(world: &impl CollisionWorld, mut bounds: Aabb, mut delta: [f64; 3]) -> [f64; 3] {
    let mut swept = bounds;
    for (a, d) in delta.iter().copied().enumerate() {
        swept.min[a] += d.min(0.0);
        swept.max[a] += d.max(0.0);
    }
    // A swept broad phase prevents tunnelling even when crossing many cells.
    let mut boxes = Vec::new();
    visit(world, swept, |b| boxes.push(b));
    for axis in [1, 0, 2] {
        for b in &boxes {
            if (0..3)
                .filter(|a| *a != axis)
                .all(|a| bounds.max[a] > b.min[a] && bounds.min[a] < b.max[a])
            {
                if delta[axis] > 0.0 && bounds.max[axis] <= b.min[axis] {
                    delta[axis] = delta[axis].min(b.min[axis] - bounds.max[axis]);
                } else if delta[axis] < 0.0 && bounds.min[axis] >= b.max[axis] {
                    delta[axis] = delta[axis].max(b.max[axis] - bounds.min[axis]);
                }
            }
        }
        bounds.min[axis] += delta[axis];
        bounds.max[axis] += delta[axis];
    }
    delta
}
