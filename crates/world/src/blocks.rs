use crate::BlockState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum RenderLayer {
    Opaque,
    Cutout,
    Translucent,
}

/// Local bounds in sixteenths of a block (fence collisions reach y=24).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Box16 {
    pub min: [u8; 3],
    pub max: [u8; 3],
}
pub const FULL_BOX: Box16 = Box16 {
    min: [0; 3],
    max: [16; 3],
};
const BOTTOM: [Box16; 1] = [Box16 {
    min: [0; 3],
    max: [16, 8, 16],
}];
const TOP: [Box16; 1] = [Box16 {
    min: [0, 8, 0],
    max: [16; 3],
}];
const PLANT: [Box16; 1] = [Box16 {
    min: [5, 0, 5],
    max: [11, 10, 11],
}];
const TORCH_BOX: Box16 = Box16 {
    min: [7, 0, 7],
    max: [9, 10, 9],
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Cube,
    Boxes(&'static [Box16]),
    Cross,
    Stairs,
    Fence,
    Torch,
}

#[derive(Clone, Copy)]
pub struct BlockInfo {
    pub tool: Option<crate::items::ToolKind>,
    pub min_tier: u8,
    pub dig_ticks: Option<u16>,
    pub model: Model,
    pub layer: RenderLayer,
    /// Full opaque cube: hides adjacent faces and blocks AO/light samples.
    pub occludes: bool,
    /// Collides with players.
    pub solid: bool,
    pub falls: bool,
    pub washes_away: bool,
    /// Suppress internal faces against the same block state.
    pub cull_same: bool,
    /// Light absorption and emission, each in 0..=15.
    pub opacity: u8,
    pub emission: u8,
    pub name: &'static str,
    /// Texture layer per face, in `Direction` order: down, up, north, south, west, east.
    pub tex: [u16; 6],
    /// Faces whose grayscale texture receives grass, leaves, or water tint.
    pub tint: [bool; 6],
}

include!(concat!(env!("OUT_DIR"), "/blocks.rs"));

#[inline]
pub fn info(state: BlockState) -> &'static BlockInfo {
    &INFO[if is_valid(state) {
        state as usize
    } else {
        AIR as usize
    }]
}

#[inline]
pub const fn is_valid(state: BlockState) -> bool {
    state < COUNT
}

/// Full opaque cube: hides the faces of its neighbours and casts ambient occlusion.
#[inline]
pub fn occludes(state: BlockState) -> bool {
    info(state).occludes
}

#[inline]
pub fn is_solid(state: BlockState) -> bool {
    info(state).solid
}

pub fn is_full_opaque_cube(state: BlockState) -> bool {
    let info = info(state);
    info.solid && info.occludes && info.model == Model::Cube
}

pub fn is_oak_leaves(state: BlockState) -> bool {
    matches!(state, OAK_LEAVES | PLACED_OAK_LEAVES)
}

pub const FALLING_WATER: BlockState = FLOWING_WATER + 7;

pub fn is_flowing_water(state: BlockState) -> bool {
    (FLOWING_WATER..=FALLING_WATER).contains(&state)
}

pub fn is_water(state: BlockState) -> bool {
    state == WATER || is_flowing_water(state)
}

pub const FALLING_LAVA: BlockState = FLOWING_LAVA + 3;

pub fn is_flowing_lava(state: BlockState) -> bool {
    (FLOWING_LAVA..=FALLING_LAVA).contains(&state)
}

pub fn is_lava(state: BlockState) -> bool {
    state == LAVA || is_flowing_lava(state)
}

pub fn is_fluid(state: BlockState) -> bool {
    is_water(state) || is_lava(state)
}

pub const MOIST_FARMLAND: BlockState = FARMLAND + 1;
pub const RIPE_WHEAT: BlockState = WHEAT + 7;

pub fn is_farmland(state: BlockState) -> bool {
    matches!(state, FARMLAND | MOIST_FARMLAND)
}

pub fn is_wheat(state: BlockState) -> bool {
    (WHEAT..=RIPE_WHEAT).contains(&state)
}

/// A block owns a contiguous range; its first state is the inventory default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    pub name: &'static str,
    pub first: BlockState,
    pub count: u16,
}
pub fn registry() -> impl Iterator<Item = Block> {
    BLOCKS.iter().copied()
}
pub fn block(state: BlockState) -> Option<Block> {
    registry().find(|b| (b.first..b.first + b.count).contains(&state))
}
pub fn properties(state: BlockState) -> &'static [(&'static str, &'static str)] {
    PROPERTIES.get(state as usize).copied().unwrap_or(&[])
}
pub fn state_name(state: BlockState) -> String {
    let mut name = info(state).name.to_owned();
    let props = properties(state);
    if !props.is_empty() {
        name.push('[');
        for (i, (key, value)) in props.iter().enumerate() {
            if i > 0 {
                name.push(',');
            }
            name.push_str(&format!("{key}={value}"));
        }
        name.push(']');
    }
    name
}
pub fn parse_state(name: &str) -> Option<BlockState> {
    (0..COUNT).find(|s| state_name(*s) == name)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapePurpose {
    Collision,
    Selection,
    Render,
}

// Only facing and half are persisted. Unlike vanilla's shape/connection states,
// corners and arms are derived from cardinal neighbours on every query. This
// keeps prediction, server validation and padded-section meshing in agreement.
// Rules: https://minecraft.wiki/w/Stairs and https://minecraft.wiki/w/Fence
const CARDINAL: [(i32, i32); 4] = [(0, -1), (0, 1), (-1, 0), (1, 0)];

/// Outward normals in face order: down, up, north, south, west, east.
pub const FACE_NORMALS: [[i32; 3]; 6] = [
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
    [-1, 0, 0],
    [1, 0, 0],
];

pub fn torch_for_face(face: usize) -> Option<BlockState> {
    match face {
        1 => Some(TORCH),
        2..=5 => Some(WALL_TORCH + (face - 2) as u16),
        _ => None,
    }
}

/// The face of the supporting block that the torch is attached to.
pub fn torch_face(state: BlockState) -> Option<usize> {
    match state {
        TORCH => Some(1),
        WALL_TORCH..=WALL_TORCH_EAST => Some(2 + usize::from(state - WALL_TORCH)),
        _ => None,
    }
}

const WALL_TORCH_EAST: BlockState = WALL_TORCH + 3;

/// Deform a vertex from the upright torch box, keeping its UV coordinates.
pub fn torch_vertex(state: BlockState, [x, y, z]: [i32; 3]) -> [i32; 3] {
    let Some(face @ 2..=5) = torch_face(state) else {
        return [x, y, z];
    };
    let [dx, _, dz] = FACE_NORMALS[face];
    let offset = -7 + y * 6 / 10;
    [x + dx * offset, y + 3, z + dz * offset]
}

/// Whether solid geometry covers the entire outer face. Adjacent stairs can
/// change the shape of a supporting stair without changing its state ID.
pub fn has_full_face(
    state: BlockState,
    face: usize,
    neighbor: impl Fn(i32, i32, i32) -> BlockState,
) -> bool {
    let Some(normal) = FACE_NORMALS.get(face) else {
        return false;
    };
    if !is_solid(state) {
        return false;
    }
    if info(state).model == Model::Cube {
        return true;
    }
    let axis = face / 2;
    // Face order is Y, Z, X.
    let [depth, u, v] = [[1, 0, 2], [2, 0, 1], [0, 1, 2]][axis];
    let mut rows = [0u16; 16];
    shape_boxes(state, neighbor, ShapePurpose::Collision, |b| {
        if (normal[depth] < 0 && b.min[depth] != 0) || (normal[depth] > 0 && b.max[depth] < 16) {
            return;
        }
        let mask = (u16::MAX << b.min[u]) & (u16::MAX >> (16 - b.max[u].min(16)));
        for row in &mut rows[b.min[v] as usize..b.max[v].min(16) as usize] {
            *row |= mask;
        }
    });
    rows == [u16::MAX; 16]
}

fn stair(state: BlockState) -> Option<(usize, bool)> {
    (info(state).model == Model::Stairs).then(|| {
        let index = state - block(state).unwrap().first;
        ((index / 2) as usize, index % 2 == 1)
    })
}
fn half_box(direction: usize, low: u8, high: u8) -> Box16 {
    let (dx, dz) = CARDINAL[direction];
    Box16 {
        min: [if dx > 0 { 8 } else { 0 }, low, if dz > 0 { 8 } else { 0 }],
        max: [
            if dx < 0 { 8 } else { 16 },
            high,
            if dz < 0 { 8 } else { 16 },
        ],
    }
}
pub fn shape_boxes(
    state: BlockState,
    neighbor: impl Fn(i32, i32, i32) -> BlockState,
    purpose: ShapePurpose,
    mut visit: impl FnMut(Box16),
) {
    if !is_valid(state)
        || state == AIR
        || (purpose != ShapePurpose::Render && is_fluid(state))
        || (purpose == ShapePurpose::Collision && !is_solid(state))
    {
        return;
    }
    match info(state).model {
        Model::Cube => visit(FULL_BOX),
        Model::Boxes(boxes) => boxes.iter().copied().for_each(visit),
        Model::Cross => PLANT.iter().copied().for_each(visit),
        Model::Torch => {
            let mut bounds = TORCH_BOX;
            if purpose == ShapePurpose::Selection {
                let low = torch_vertex(state, bounds.min.map(i32::from));
                let high = torch_vertex(state, bounds.max.map(i32::from));
                let other_low = torch_vertex(state, [7, 10, 7]);
                let other_high = torch_vertex(state, [9, 0, 9]);
                bounds.min = std::array::from_fn(|a| low[a].min(other_low[a]) as u8);
                bounds.max = std::array::from_fn(|a| high[a].max(other_high[a]) as u8);
            }
            visit(bounds);
        }
        Model::Stairs => {
            let (facing, top) = stair(state).unwrap();
            visit(if top { TOP[0] } else { BOTTOM[0] });
            let (low, high) = if top { (0, 8) } else { (8, 16) };
            let (dx, dz) = CARDINAL[facing];
            let same = |x, z| stair(neighbor(x, 0, z)) == Some((facing, top));
            let mut step = half_box(facing, low, high);
            // Front perpendicular stair cuts the upper step to a quarter (outer).
            // A same-facing stair on the opposite side prevents this corner.
            if let Some((other, half)) = stair(neighbor(dx, 0, dz)) {
                let (ox, oz) = CARDINAL[other];
                if half == top && dx * ox + dz * oz == 0 && !same(-ox, -oz) {
                    let cut = half_box(other, low, high);
                    for a in [0, 2] {
                        step.min[a] = step.min[a].max(cut.min[a]);
                        step.max[a] = step.max[a].min(cut.max[a]);
                    }
                    visit(step);
                    return;
                }
            }
            visit(step);
            // Rear perpendicular stair adds the missing quarter (inner).
            if let Some((other, half)) = stair(neighbor(-dx, 0, -dz)) {
                let (ox, oz) = CARDINAL[other];
                if half == top && dx * ox + dz * oz == 0 && !same(ox, oz) {
                    let mut extra = half_box(facing ^ 1, low, high);
                    let cut = half_box(other, low, high);
                    for a in [0, 2] {
                        extra.min[a] = extra.min[a].max(cut.min[a]);
                        extra.max[a] = extra.max[a].min(cut.max[a]);
                    }
                    visit(extra);
                }
            }
        }
        Model::Fence => {
            let height = if purpose == ShapePurpose::Collision {
                24
            } else {
                16
            };
            visit(Box16 {
                min: [6, 0, 6],
                max: [10, height, 10],
            });
            for (dx, dz) in CARDINAL {
                let other = neighbor(dx, 0, dz);
                if info(other).model != Model::Fence && !occludes(other) {
                    continue;
                }
                let mut arm = Box16 {
                    min: [
                        if dx < 0 {
                            0
                        } else if dx > 0 {
                            10
                        } else {
                            7
                        },
                        0,
                        if dz < 0 {
                            0
                        } else if dz > 0 {
                            10
                        } else {
                            7
                        },
                    ],
                    max: [
                        if dx > 0 {
                            16
                        } else if dx < 0 {
                            6
                        } else {
                            9
                        },
                        height,
                        if dz > 0 {
                            16
                        } else if dz < 0 {
                            6
                        } else {
                            9
                        },
                    ],
                };
                if purpose == ShapePurpose::Render {
                    for (low, high) in [(6, 9), (12, 15)] {
                        arm.min[1] = low;
                        arm.max[1] = high;
                        visit(arm);
                    }
                } else {
                    visit(arm);
                }
            }
        }
    }
}
pub fn selection_boxes(
    state: BlockState,
    neighbor: impl Fn(i32, i32, i32) -> BlockState,
) -> Vec<Box16> {
    let mut boxes = Vec::new();
    shape_boxes(state, neighbor, ShapePurpose::Selection, |b| boxes.push(b));
    boxes
}
pub fn collision_boxes(
    state: BlockState,
    neighbor: impl Fn(i32, i32, i32) -> BlockState,
) -> Vec<Box16> {
    let mut boxes = Vec::new();
    shape_boxes(state, neighbor, ShapePurpose::Collision, |b| boxes.push(b));
    boxes
}
/// Server placement policy: plants need support and wheat is planted as seed.
pub fn can_place(old: BlockState, new: BlockState, below: BlockState) -> bool {
    if is_wheat(new) {
        return new == WHEAT && old == AIR && is_farmland(below);
    }
    is_valid(new) && (info(new).model != Model::Cross || occludes(below))
}

#[cfg(test)]
mod tests {
    use super::*;
    const fn all(t: u16) -> [u16; 6] {
        [t; 6]
    }
    fn boxes_at(state: BlockState, cells: &[(i32, i32, BlockState)]) -> Vec<Box16> {
        selection_boxes(state, |x, _, z| {
            cells
                .iter()
                .find(|c| c.0 == x && c.1 == z)
                .map_or(AIR, |c| c.2)
        })
    }

    #[test]
    fn biome_blocks_append_and_ice_uses_existing_translucency() {
        assert_eq!(
            [SNOW_BLOCK, SANDSTONE, GRAVEL, ICE, COARSE_DIRT],
            [40, 41, 42, 43, 44]
        );
        for state in [SNOW_BLOCK, SANDSTONE, GRAVEL, COARSE_DIRT] {
            assert!(info(state).solid && info(state).occludes);
            assert_eq!(info(state).opacity, 15);
        }
        let ice = info(ICE);
        assert!(ice.solid && ice.cull_same && !ice.occludes);
        assert_eq!(ice.layer, RenderLayer::Translucent);
        assert_eq!(ice.opacity, 1);
    }

    #[test]
    fn appended_state_ids_and_properties() {
        let old = [
            "oak_slab[type=bottom]",
            "oak_slab[type=top]",
            "oak_slab[type=double]",
            "cobblestone_slab[type=bottom]",
            "cobblestone_slab[type=top]",
            "cobblestone_slab[type=double]",
            "red_flower",
            "yellow_flower",
            "short_grass",
        ];
        for (i, name) in old.iter().enumerate() {
            assert_eq!(parse_state(name), Some(14 + i as u16));
        }
        assert_eq!(
            (
                OAK_STAIRS,
                COBBLESTONE_STAIRS,
                OAK_FENCE,
                PLACED_OAK_LEAVES,
                FARMLAND,
                WHEAT,
                FLOWING_WATER
            ),
            (23, 31, 39, 51, 52, 54, 62)
        );
        assert_eq!(FURNACE, 50);
        assert_eq!(block(FURNACE).unwrap().count, 1);
        assert!(properties(FURNACE).is_empty());
        for base in [OAK_STAIRS, COBBLESTONE_STAIRS] {
            assert_eq!(block(base).unwrap().count, 8);
            for (f, facing) in ["north", "south", "west", "east"].iter().enumerate() {
                for (h, half) in ["bottom", "top"].iter().enumerate() {
                    let state = base + (f * 2 + h) as u16;
                    assert_eq!(properties(state), &[("facing", *facing), ("half", *half)]);
                }
            }
        }
        assert_eq!(block(OAK_FENCE).unwrap().count, 1);
        for state in OAK_STAIRS..=OAK_FENCE {
            assert!(is_solid(state));
            assert!(!occludes(state));
            assert_eq!(info(state).opacity, 0);
            assert_eq!(
                info(state).tex,
                all(if state < COBBLESTONE_STAIRS || state == OAK_FENCE {
                    5
                } else {
                    4
                })
            );
        }
    }

    #[test]
    fn torch_states_emit_light_and_have_only_selection_bounds() {
        assert_eq!((TORCH, WALL_TORCH, COUNT), (77, 78, 85));
        assert_eq!(block(TORCH).unwrap().count, 1);
        assert_eq!(block(WALL_TORCH).unwrap().count, 4);
        assert_eq!(torch_for_face(0), None);
        assert_eq!(torch_for_face(6), None);
        for (face, state) in (1..6).zip(TORCH..COUNT) {
            let torch = info(state);
            assert_eq!(torch_for_face(face), Some(state));
            assert_eq!(torch_face(state), Some(face));
            assert_eq!(
                (torch.model, torch.layer),
                (Model::Torch, RenderLayer::Cutout)
            );
            assert_eq!(
                (torch.emission, torch.opacity, torch.dig_ticks),
                (14, 0, Some(0))
            );
            assert!(!torch.solid && !torch.occludes);
            assert!(collision_boxes(state, |_, _, _| AIR).is_empty());
        }
        assert_eq!(boxes_at(TORCH, &[]), vec![TORCH_BOX]);
        for (i, (facing, min, max)) in [
            ("north", [7, 3, 8], [9, 13, 16]),
            ("south", [7, 3, 0], [9, 13, 8]),
            ("west", [8, 3, 7], [16, 13, 9]),
            ("east", [0, 3, 7], [8, 13, 9]),
        ]
        .into_iter()
        .enumerate()
        {
            let state = WALL_TORCH + i as u16;
            assert_eq!(properties(state), &[("facing", facing)]);
            assert_eq!(boxes_at(state, &[]), vec![Box16 { min, max }]);
        }
    }

    #[test]
    fn stair_straight_and_both_corners_all_facings_and_halves() {
        // Independent expected horizontal half bounds: north, south, west, east.
        let halves = [
            ([0, 0], [16, 8]),
            ([0, 8], [16, 16]),
            ([0, 0], [8, 16]),
            ([8, 0], [16, 16]),
        ];
        for facing in 0..4 {
            let (dx, dz) = CARDINAL[facing];
            for half in 0..2 {
                let state = OAK_STAIRS + facing as u16 * 2 + half;
                let (lo, hi) = if half == 0 { (8, 16) } else { (0, 8) };
                let base = if half == 0 { BOTTOM[0] } else { TOP[0] };
                let make = |min: [u8; 2], max: [u8; 2]| Box16 {
                    min: [min[0], lo, min[1]],
                    max: [max[0], hi, max[1]],
                };
                let (min, max) = halves[facing];
                let step = make(min, max);
                assert_eq!(boxes_at(state, &[]), vec![base, step]);
                for other in 0..4 {
                    let (ox, oz) = CARDINAL[other];
                    if dx * ox + dz * oz != 0 {
                        continue;
                    }
                    let adjacent = COBBLESTONE_STAIRS + other as u16 * 2 + half;
                    let (omin, omax) = halves[other];
                    let intersect = |a: [u8; 2], b: [u8; 2]| {
                        make(
                            [a[0].max(omin[0]), a[1].max(omin[1])],
                            [b[0].min(omax[0]), b[1].min(omax[1])],
                        )
                    };
                    // Both left and right, outer and inner, including mixed materials.
                    assert_eq!(
                        boxes_at(state, &[(dx, dz, adjacent)]),
                        vec![base, intersect(min, max)]
                    );
                    let (rear_min, rear_max) = halves[facing ^ 1];
                    assert_eq!(
                        boxes_at(state, &[(-dx, -dz, adjacent)]),
                        vec![base, step, intersect(rear_min, rear_max)]
                    );
                    // Opposite halves never join; side continuations suppress corners.
                    let different_half = if half == 0 {
                        adjacent + 1
                    } else {
                        adjacent - 1
                    };
                    assert_eq!(
                        boxes_at(state, &[(dx, dz, different_half)]),
                        vec![base, step]
                    );
                    assert_eq!(
                        boxes_at(state, &[(dx, dz, adjacent), (-ox, -oz, state)]),
                        vec![base, step]
                    );
                    assert_eq!(
                        boxes_at(state, &[(-dx, -dz, adjacent), (ox, oz, state)]),
                        vec![base, step]
                    );
                    // Front (outer) wins when both ends can form a corner.
                    assert_eq!(
                        boxes_at(state, &[(dx, dz, adjacent), (-dx, -dz, adjacent)]),
                        vec![base, intersect(min, max)]
                    );
                }
            }
        }
    }

    #[test]
    fn fence_connections_and_purpose_specific_heights() {
        let post = Box16 {
            min: [6, 0, 6],
            max: [10, 16, 10],
        };
        assert_eq!(boxes_at(OAK_FENCE, &[]), vec![post]);
        for (dx, dz) in CARDINAL {
            for other in [AIR, OAK_FENCE, STONE, GLASS, OAK_STAIRS, OAK_SLAB] {
                let neighbor = |x, _, z| if (x, z) == (dx, dz) { other } else { AIR };
                let selection = selection_boxes(OAK_FENCE, neighbor);
                let collision = collision_boxes(OAK_FENCE, neighbor);
                let connects = matches!(other, OAK_FENCE | STONE);
                assert_eq!(selection.len(), if connects { 2 } else { 1 });
                assert_eq!(collision.len(), selection.len());
                for (s, c) in selection.iter().zip(collision) {
                    assert_eq!(s.max[1], 16);
                    assert_eq!(c.max[1], 24);
                    assert_eq!(s.min, c.min);
                    assert_eq!((s.max[0], s.max[2]), (c.max[0], c.max[2]));
                }
                if connects {
                    let arm = selection[1];
                    assert_eq!(
                        if dx < 0 {
                            arm.min[0]
                        } else if dx > 0 {
                            arm.max[0]
                        } else if dz < 0 {
                            arm.min[2]
                        } else {
                            arm.max[2]
                        },
                        if dx + dz < 0 { 0 } else { 16 }
                    );
                }
                let mut render = Vec::new();
                shape_boxes(OAK_FENCE, neighbor, ShapePurpose::Render, |b| {
                    render.push(b)
                });
                assert_eq!(render[0], post);
                assert_eq!(render.len(), if connects { 3 } else { 1 });
                if connects {
                    assert_eq!(
                        (
                            render[1].min[1],
                            render[1].max[1],
                            render[2].min[1],
                            render[2].max[1]
                        ),
                        (6, 9, 12, 15)
                    );
                }
            }
        }
    }

    #[test]
    fn state_registry_round_trip_and_legacy_ids() {
        let legacy = [
            "air",
            "stone",
            "grass_block",
            "dirt",
            "cobblestone",
            "oak_planks",
            "bedrock",
            "sand",
            "oak_log",
            "bricks",
            "lamp_block",
            "glass",
            "oak_leaves",
            "water",
        ];
        for (id, name) in legacy.into_iter().enumerate() {
            assert_eq!(parse_state(name), Some(id as u16));
            assert_eq!(block(id as u16).unwrap().count, 1);
        }
        for s in 0..COUNT {
            assert_eq!(parse_state(&state_name(s)), Some(s));
            let b = block(s).unwrap();
            assert!((b.first..b.first + b.count).contains(&s));
        }
        assert_eq!(properties(OAK_SLAB + 1), &[("type", "top")]);
        assert!(!is_valid(COUNT));
        assert!(block(u16::MAX).is_none());
    }
}
