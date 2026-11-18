//! Turns one 16x16x16 section into quads.
//!
//! Like the game, every visible block face is its own quad (no greedy
//! merging): per-vertex ambient occlusion and per-vertex light make
//! neighbouring faces differ.
//!
//! Vertex layout, two `u32` per vertex:
//! ```text
//! word 0: x:9 | y:9 | z:9 | face:3 | ao:2 (position in sixteenths, 0..=256)
//! word 1: texture layer:12 | tint:1 | sky:4 | block:4 | u:5 | v:5 | fluid_top:1
//! ```
//! Four vertices per quad, counter-clockwise seen from outside. The index
//! pattern `0 1 2, 0 2 3` is shared by all quads; when ambient occlusion asks
//! for the other diagonal the vertices are emitted rotated by one.

use world::{blocks, BlockState};

/// Edge length of the padded input: the section plus one block on every side.
pub const PADDED: usize = 18;
pub const PADDED_LEN: usize = PADDED * PADDED * PADDED;
pub const WORDS_PER_QUAD: usize = 8;

/// Index into the padded array for coordinates in -1..=16.
#[inline]
pub fn padded_index(x: i32, y: i32, z: i32) -> usize {
    ((y + 1) as usize * PADDED + (z + 1) as usize) * PADDED + (x + 1) as usize
}

/// Faces in the game's `Direction` order.
pub const DOWN: usize = 0;
pub const UP: usize = 1;
pub const NORTH: usize = 2;
pub const SOUTH: usize = 3;
pub const WEST: usize = 4;
pub const EAST: usize = 5;

struct Face {
    normal: [i32; 3],
    /// Two in-plane axes with `b x c = normal`, which makes the corner order
    /// (0,0) (1,0) (1,1) (0,1) counter-clockwise from outside.
    b: [i32; 3],
    c: [i32; 3],
}

const FACES: [Face; 6] = [
    Face {
        normal: [0, -1, 0],
        b: [1, 0, 0],
        c: [0, 0, 1],
    },
    Face {
        normal: [0, 1, 0],
        b: [0, 0, 1],
        c: [1, 0, 0],
    },
    Face {
        normal: [0, 0, -1],
        b: [0, 1, 0],
        c: [1, 0, 0],
    },
    Face {
        normal: [0, 0, 1],
        b: [1, 0, 0],
        c: [0, 1, 0],
    },
    Face {
        normal: [-1, 0, 0],
        b: [0, 0, 1],
        c: [0, 1, 0],
    },
    Face {
        normal: [1, 0, 0],
        b: [0, 1, 0],
        c: [0, 0, 1],
    },
];

const CORNERS: [(i32, i32); 4] = [(0, 0), (1, 0), (1, 1), (0, 1)];

/// Texture coordinates in sixteenths, cropped to the box position on a face.
/// Side faces keep "up" at v = 0 and are not mirrored when seen from outside.
#[inline]
fn uv(face: usize, p: [i32; 3]) -> (u32, u32) {
    let (u, v) = match face {
        DOWN => (p[0], 16 - p[2]),
        UP => (p[0], p[2]),
        NORTH => (16 - p[0], 16 - p[1]),
        SOUTH => (p[0], 16 - p[1]),
        WEST => (p[2], 16 - p[1]),
        _ => (16 - p[2], 16 - p[1]),
    };
    (u as u32, v as u32)
}

/// Fluid heights use the packed sixteenth coordinate and the existing 1/9 drop.
#[derive(Clone, Copy)]
struct FluidTop {
    y: i32,
    lowered: bool,
}

fn same_fluid(state: BlockState, neighbor: BlockState) -> bool {
    (blocks::is_water(state) && blocks::is_water(neighbor))
        || (blocks::is_lava(state) && blocks::is_lava(neighbor))
}

impl FluidTop {
    fn at(padded: &[BlockState], x: i32, y: i32, z: i32, state: BlockState) -> Self {
        if same_fluid(state, padded[padded_index(x, y + 1, z)]) {
            Self {
                y: 16,
                lowered: false,
            }
        } else if matches!(
            state,
            blocks::WATER | blocks::FALLING_WATER | blocks::LAVA | blocks::FALLING_LAVA
        ) {
            Self {
                y: 16,
                lowered: true,
            }
        } else {
            let first = if blocks::is_lava(state) {
                blocks::FLOWING_LAVA
            } else {
                blocks::FLOWING_WATER
            };
            Self {
                y: 14 - 2 * i32::from(state - first),
                lowered: false,
            }
        }
    }

    fn height(self) -> i32 {
        self.y * 9 - i32::from(self.lowered) * 16
    }
}

/// Meshes a section from its padded block array and appends vertex words to
/// `out`. Returns the number of quads.
///
/// Ambient occlusion levels 0..=3 count how open a vertex is: the two edge
/// neighbours and the diagonal one, where two solid edges also close the
/// diagonal. Mapped to 0.4/0.6/0.8/1.0 brightness this equals averaging the
/// game's 0.2 shade of opaque cubes over the four blocks touching a vertex.
pub fn mesh_section(padded: &[BlockState], out: &mut Vec<u32>) -> u32 {
    mesh_section_lit(padded, None, out)
}

/// Missing light uses full daylight (sky 15, block 0).
/// Samples on the outside of the face exclude opaque blocks; averages round
/// to the nearest integer before packing into four bits.
pub fn mesh_section_lit(
    padded: &[BlockState],
    light: Option<(&[u8], &[u8])>,
    out: &mut Vec<u32>,
) -> u32 {
    mesh_section_layers(padded, light, out).iter().sum()
}

/// Appends opaque, cutout, then translucent quads; returns counts in that order.
pub fn mesh_section_layers(
    padded: &[BlockState],
    light: Option<(&[u8], &[u8])>,
    out: &mut Vec<u32>,
) -> [u32; 3] {
    assert_eq!(padded.len(), PADDED_LEN);
    if let Some((sky, block)) = light {
        assert_eq!(sky.len(), PADDED_LEN);
        assert_eq!(block.len(), PADDED_LEN);
    }
    let mut layers: [Vec<u32>; 3] = std::array::from_fn(|_| Vec::new());
    let mut boxes = Vec::with_capacity(9);
    for y in 0..16i32 {
        for z in 0..16i32 {
            for x in 0..16i32 {
                let state = padded[padded_index(x, y, z)];
                if state == blocks::AIR {
                    continue;
                }
                let info = blocks::info(state);
                let fluid_top =
                    blocks::is_fluid(state).then(|| FluidTop::at(padded, x, y, z, state));
                let out = &mut layers[info.layer as usize];
                if info.model == blocks::Model::Cross {
                    let idx = padded_index(x, y, z);
                    let (sky, block) = light.map_or((15, 0), |(s, b)| (s[idx], b[idx]));
                    for plane in [
                        [[2, 0, 2], [14, 0, 14], [14, 16, 14], [2, 16, 2]],
                        [[14, 0, 2], [2, 0, 14], [2, 16, 14], [14, 16, 2]],
                    ] {
                        for reverse in [false, true] {
                            for k in 0..4 {
                                let j = if reverse { 3 - k } else { k };
                                let p = plane[j];
                                out.extend(pack(
                                    [x * 16 + p[0], y * 16 + p[1], z * 16 + p[2]],
                                    UP,
                                    3,
                                    ((j == 1 || j == 2) as u32 * 16, (j < 2) as u32 * 16),
                                    info.tex[0],
                                    info.tint[0],
                                    sky as u32,
                                    block as u32,
                                    false,
                                ));
                            }
                        }
                    }
                    continue;
                }
                boxes.clear();
                blocks::shape_boxes(
                    state,
                    |dx, dy, dz| padded[padded_index(x + dx, y + dy, z + dz)],
                    blocks::ShapePurpose::Render,
                    |b| boxes.push(b),
                );
                for bounds in &boxes {
                    for (f, face) in FACES.iter().enumerate() {
                        let n = face.normal;
                        let (ax, ay, az) = (x + n[0], y + n[1], z + n[2]);
                        let neighbor = padded[padded_index(ax, ay, az)];
                        // A taller fluid cell exposes a strip above a neighboring
                        // surface. For side faces ay + 1 <= 16, including
                        // horizontal neighbors in the padding.
                        let joins_fluid = fluid_top.is_some() && same_fluid(state, neighbor);
                        let fluid_strip = fluid_top.and_then(|top| {
                            if f < NORTH || !joins_fluid {
                                return None;
                            }
                            let other = FluidTop::at(padded, ax, ay, az, neighbor);
                            (top.height() > other.height()).then_some(other)
                        });
                        let axis = n.iter().position(|v| *v != 0).unwrap();
                        // A lowered fluid top lies inside its cell, so blocks
                        // above cannot cull it or supply its AO/light samples.
                        let boundary = (if n[axis] < 0 {
                            bounds.min[axis] == 0
                        } else {
                            bounds.max[axis] == 16
                        }) && !(f == UP
                            && fluid_top.is_some_and(|top| top.height() < 144));
                        let same = state == neighbor
                            || joins_fluid
                            || (blocks::is_oak_leaves(state) && blocks::is_oak_leaves(neighbor));
                        if boundary
                            && (blocks::occludes(neighbor)
                                || (same && info.cull_same && fluid_strip.is_none()))
                        {
                            continue;
                        }

                        let mut words = [[0u32; 2]; 4];
                        let mut ao = [0u32; 4];
                        for (k, &(i, j)) in CORNERS.iter().enumerate() {
                            let (si, sj) = (2 * i - 1, 2 * j - 1);
                            let solid = |d: [i32; 3]| -> bool {
                                blocks::occludes(
                                    padded[padded_index(ax + d[0], ay + d[1], az + d[2])],
                                )
                            };
                            let side1 = solid([face.b[0] * si, face.b[1] * si, face.b[2] * si]);
                            let side2 = solid([face.c[0] * sj, face.c[1] * sj, face.c[2] * sj]);
                            let corner = solid([
                                face.b[0] * si + face.c[0] * sj,
                                face.b[1] * si + face.c[1] * sj,
                                face.b[2] * si + face.c[2] * sj,
                            ]);
                            ao[k] = if !boundary {
                                3
                            } else if side1 && side2 {
                                0
                            } else {
                                3 - (side1 as u32 + side2 as u32 + corner as u32)
                            };

                            // Corner position inside the unit cube.
                            let on = |axis: usize| -> i32 {
                                if n[axis] != 0 {
                                    if n[axis] > 0 {
                                        bounds.max[axis] as i32
                                    } else {
                                        bounds.min[axis] as i32
                                    }
                                } else {
                                    bounds.min[axis] as i32
                                        + (bounds.max[axis] - bounds.min[axis]) as i32
                                            * (face.b[axis] * i + face.c[axis] * j)
                                }
                            };
                            let mut p = [on(0), on(1), on(2)];
                            let edge = if p[1] == 16 { fluid_top } else { fluid_strip };
                            // The flag carries the shader's exact 1/9 displacement.
                            let lowered = edge.is_some_and(|top| top.lowered);
                            if let Some(top) = edge {
                                p[1] = top.y;
                            }
                            let (u, v) = uv(f, p);
                            let mut sums = [0u32; 2];
                            let mut count = 0;
                            for db in [0, si] {
                                for dc in [0, sj] {
                                    let idx = padded_index(
                                        ax + face.b[0] * db + face.c[0] * dc,
                                        ay + face.b[1] * db + face.c[1] * dc,
                                        az + face.b[2] * db + face.c[2] * dc,
                                    );
                                    if !blocks::occludes(padded[idx]) {
                                        let (sky, block) =
                                            light.map_or((15, 0), |(s, b)| (s[idx], b[idx]));
                                        sums[0] += sky as u32;
                                        sums[1] += block as u32;
                                        count += 1;
                                    }
                                }
                            }
                            if !boundary {
                                let idx = padded_index(x, y, z);
                                let (sky, block) = light.map_or((15, 0), |(s, b)| (s[idx], b[idx]));
                                sums = [sky as u32, block as u32];
                                count = 1;
                            }
                            // Boundary faces have a non-occluding direct neighbor;
                            // internal faces always use their own cell.
                            debug_assert!(count > 0);
                            let sky = (sums[0] + count / 2) / count;
                            let block = (sums[1] + count / 2) / count;
                            words[k] = pack(
                                [x * 16 + p[0], y * 16 + p[1], z * 16 + p[2]],
                                f,
                                ao[k],
                                (u, v),
                                info.tex[f],
                                info.tint[f],
                                sky,
                                block,
                                lowered,
                            );
                        }

                        // Split along the brighter diagonal so shading is symmetric.
                        let start = if ao[0] + ao[2] >= ao[1] + ao[3] { 0 } else { 1 };
                        for k in 0..4 {
                            let w = words[(start + k) % 4];
                            out.push(w[0]);
                            out.push(w[1]);
                        }
                    }
                }
            }
        }
    }
    let counts = layers.each_ref().map(|v| (v.len() / WORDS_PER_QUAD) as u32);
    for layer in layers {
        out.extend(layer);
    }
    counts
}

/// Two-word vertex ABI shared by WASM, the renderer and translucent sorting.
#[allow(clippy::too_many_arguments)]
fn pack(
    p: [i32; 3],
    face: usize,
    ao: u32,
    uv: (u32, u32),
    tex: u16,
    tint: bool,
    sky: u32,
    block: u32,
    fluid_top: bool,
) -> [u32; 2] {
    [
        p[0] as u32 | (p[1] as u32) << 9 | (p[2] as u32) << 18 | (face as u32) << 27 | ao << 30,
        tex as u32
            | (tint as u32) << 12
            | sky << 13
            | block << 17
            | uv.0 << 21
            | uv.1 << 26
            | (fluid_top as u32) << 31,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> Vec<BlockState> {
        vec![blocks::AIR; PADDED_LEN]
    }

    fn position(v: &[u32]) -> [u32; 3] {
        [v[0] & 511, (v[0] >> 9) & 511, (v[0] >> 18) & 511]
    }

    #[test]
    fn dense_partial_models_fit_the_section_quad_budget() {
        for (state, per_cell) in [
            (blocks::OAK_SLAB, 6),
            (blocks::RED_FLOWER, 4),
            (blocks::OAK_STAIRS, 12),
            (blocks::OAK_FENCE, 54),
        ] {
            let p = vec![state; PADDED_LEN];
            let mut out = Vec::new();
            assert_eq!(mesh_section(&p, &mut out), 4096 * per_cell);
            assert_eq!(out.len(), 4096 * per_cell as usize * WORDS_PER_QUAD);
        }
    }

    #[test]
    fn stairs_use_padded_corners_and_cull_only_boundary_faces() {
        let mut p = empty();
        p[padded_index(0, 0, 0)] = blocks::OAK_STAIRS;
        for (neighbor, expected) in [
            (blocks::AIR, 12),
            (blocks::STONE, 10),
            (blocks::COBBLESTONE_STAIRS + 4, 12),
        ] {
            p[padded_index(0, 0, -1)] = neighbor;
            let mut out = Vec::new();
            assert_eq!(mesh_section(&p, &mut out), expected);
            let top: Vec<_> = out
                .chunks(8)
                .filter(|q| ((q[0] >> 27) & 7) == UP as u32)
                .collect();
            assert_eq!(top.len(), 2);
            let upper: Vec<_> = top.into_iter().filter(|q| position(q)[1] == 16).collect();
            assert_eq!(upper.len(), 1);
            let positions: Vec<_> = upper[0].chunks(2).map(position).collect();
            assert_eq!(positions.iter().map(|p| p[2]).max(), Some(8));
            assert_eq!(
                positions.iter().map(|p| p[0]).max(),
                Some(if neighbor == blocks::COBBLESTONE_STAIRS + 4 {
                    8
                } else {
                    16
                })
            );
        }
        // A stone above hides the step top but leaves the internal slab top.
        let mut p = empty();
        p[padded_index(0, 15, 0)] = blocks::OAK_STAIRS;
        p[padded_index(0, 16, 0)] = blocks::STONE;
        let mut out = Vec::new();
        assert_eq!(mesh_section(&p, &mut out), 11);
        let tops: Vec<_> = out
            .chunks(8)
            .filter(|q| ((q[0] >> 27) & 7) == UP as u32)
            .collect();
        assert_eq!(tops.len(), 1);
        assert_eq!(position(tops[0])[1], 248);
    }

    #[test]
    fn fence_rails_use_padding_and_boundary_culling() {
        for other in [blocks::AIR, blocks::OAK_FENCE, blocks::STONE] {
            let mut p = empty();
            p[padded_index(15, 0, 0)] = blocks::OAK_FENCE;
            p[padded_index(16, 0, 0)] = other;
            let mut out = Vec::new();
            assert_eq!(
                mesh_section(&p, &mut out),
                match other {
                    blocks::AIR => 6,
                    blocks::STONE => 16,
                    _ => 18,
                }
            );
            let positions: Vec<_> = out.chunks(2).map(position).collect();
            assert_eq!(
                positions.iter().map(|p| p[0]).max(),
                Some(if other == blocks::AIR { 250 } else { 256 })
            );
            assert_eq!(positions.iter().map(|p| p[1]).max(), Some(16));
            if other != blocks::AIR {
                for y in [6, 9, 12, 15] {
                    assert!(positions.iter().any(|p| p[0] == 256 && p[1] == y));
                }
            }
        }
    }

    #[test]
    fn slabs_have_six_faces_at_exact_positions_and_cropped_uvs() {
        for base in [blocks::OAK_SLAB, blocks::COBBLESTONE_SLAB] {
            for (kind, lo, hi) in [(0, 0, 8), (1, 8, 16), (2, 0, 16)] {
                let mut p = empty();
                // Exercise the maximum section coordinate, 256.
                p[padded_index(15, 15, 15)] = base + kind;
                let mut out = Vec::new();
                assert_eq!(mesh_section(&p, &mut out), 6);
                let ys: Vec<_> = out.chunks(2).map(|v| position(v)[1]).collect();
                assert_eq!(ys.iter().min(), Some(&(240 + lo)));
                assert_eq!(ys.iter().max(), Some(&(240 + hi)));
                for q in out.chunks(8) {
                    let face = (q[0] >> 27) & 7;
                    for v in q.chunks(2) {
                        let local = position(v).map(|a| a as i32 - 240);
                        assert_eq!(
                            ((v[1] >> 21) & 31, (v[1] >> 26) & 31),
                            uv(face as usize, local)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn only_boundary_faces_are_culled_and_partial_shapes_do_not_hide_neighbors() {
        for (kind, internal_face) in [(0, UP), (1, DOWN), (2, usize::MAX)] {
            for (f, face) in FACES.iter().enumerate() {
                let mut p = empty();
                p[padded_index(0, 0, 0)] = blocks::OAK_SLAB + kind;
                // A padded neighbor contributes no faces itself.
                let n = face.normal;
                let cell = n.map(|a| if a > 0 { 15 } else { 0 });
                p[padded_index(0, 0, 0)] = blocks::AIR;
                p[padded_index(cell[0], cell[1], cell[2])] = blocks::OAK_SLAB + kind;
                p[padded_index(cell[0] + n[0], cell[1] + n[1], cell[2] + n[2])] = blocks::STONE;
                assert_eq!(
                    mesh_section(&p, &mut Vec::new()),
                    if f == internal_face { 6 } else { 5 }
                );
            }
        }
        for neighbor in [blocks::OAK_SLAB, blocks::OAK_SLAB + 1, blocks::RED_FLOWER] {
            let mut p = empty();
            p[padded_index(15, 0, 0)] = blocks::STONE;
            p[padded_index(16, 0, 0)] = neighbor;
            assert_eq!(mesh_section(&p, &mut Vec::new()), 6);
        }
    }

    #[test]
    fn internal_faces_and_crosses_use_cell_light_without_ao() {
        for state in [
            blocks::OAK_SLAB,
            blocks::OAK_SLAB + 1,
            blocks::RED_FLOWER,
            blocks::YELLOW_FLOWER,
            blocks::SHORT_GRASS,
        ] {
            let mut p = vec![blocks::STONE; PADDED_LEN];
            p[padded_index(5, 5, 5)] = state;
            let mut sky = vec![0; PADDED_LEN];
            let mut block = vec![0; PADDED_LEN];
            sky[padded_index(5, 5, 5)] = 7;
            block[padded_index(5, 5, 5)] = 11;
            let mut out = Vec::new();
            let counts = mesh_section_layers(&p, Some((&sky, &block)), &mut out);
            let plant = blocks::info(state).model == blocks::Model::Cross;
            let layer = if plant { 1 } else { 0 };
            let texture = blocks::info(state).tex[0] as u32;
            let quads: Vec<_> = out.chunks(8).filter(|q| q[1] & 4095 == texture).collect();
            assert_eq!(quads.len(), if plant { 4 } else { 1 });
            assert!(counts[layer] >= quads.len() as u32);
            for q in &quads {
                for v in q.chunks(2) {
                    assert_eq!(v[0] >> 30, 3);
                    assert_eq!((v[1] >> 13) & 15, 7);
                    assert_eq!((v[1] >> 17) & 15, 11);
                }
            }
            if plant {
                // Every plane has an identical back with reversed winding.
                for pair in quads.chunks(2) {
                    for i in 0..4 {
                        assert_eq!(
                            position(&pair[0][i * 2..]),
                            position(&pair[1][(3 - i) * 2..])
                        );
                    }
                    let p: Vec<_> = pair[0]
                        .chunks(2)
                        .map(|v| position(v).map(|a| a as i32))
                        .collect();
                    assert_ne!(cross(sub(p[1], p[0]), sub(p[2], p[0])), [0; 3]);
                }
            }
        }
    }

    #[test]
    fn water_top_and_side_upper_edges_lower_to_eight_ninths_only_when_exposed() {
        let mut p = empty();
        p[padded_index(5, 5, 5)] = blocks::WATER;
        for stacked in [false, true] {
            if stacked {
                p[padded_index(5, 6, 5)] = blocks::WATER;
            }
            let mut out = Vec::new();
            assert_eq!(mesh_section(&p, &mut out), if stacked { 10 } else { 6 });
            let mut lowered = 0;
            for v in out.chunks(2) {
                let y = position(v)[1] as f64 / 16.0;
                let flag = v[1] >> 31;
                let expected_flag = u32::from(y == if stacked { 7.0 } else { 6.0 });
                assert_eq!(flag, expected_flag);
                let rendered_y = y - flag as f64 / 9.0;
                if flag == 1 {
                    lowered += 1;
                    assert!(
                        (rendered_y - (if stacked { 6.0 } else { 5.0 }) - 8.0 / 9.0).abs() < 1e-12
                    );
                }
            }
            assert_eq!(lowered, 12); // Four top corners and two upper corners on each side.
        }
    }

    #[test]
    fn flowing_water_culls_equal_neighbors_and_emits_only_the_exposed_step() {
        for (state, height) in
            (blocks::FLOWING_WATER..blocks::FALLING_WATER).zip((2..=14).rev().step_by(2))
        {
            let mut p = empty();
            p[padded_index(5, 5, 5)] = state;
            p[padded_index(6, 5, 5)] = state;
            let mut out = Vec::new();
            assert_eq!(mesh_section(&p, &mut out), 10);
            let top = out
                .as_chunks::<2>()
                .0
                .iter()
                .filter(|v| (v[0] >> 27) & 7 == UP as u32);
            for vertex in top {
                assert_eq!(position(vertex)[1], 80 + height);
                assert_eq!(vertex[1] >> 31, 0);
            }
            p[padded_index(5, 5, 5)] = blocks::FALLING_WATER;
            out.clear();
            assert_eq!(mesh_section(&p, &mut out), 11);
            let steps: Vec<_> = out
                .as_chunks::<8>()
                .0
                .iter()
                .filter(|q| {
                    q.as_chunks::<2>()
                        .0
                        .iter()
                        .all(|v| position(v)[0] == 96 && (v[0] >> 27) & 7 == EAST as u32)
                })
                .collect();
            assert_eq!(steps.len(), 1);
            let mut edges: Vec<_> = steps[0]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|v| (position(v)[1], v[1] >> 31))
                .collect();
            edges.sort_unstable();
            assert_eq!(
                edges,
                [(80 + height, 0), (80 + height, 0), (96, 1), (96, 1)]
            );
        }
    }

    #[test]
    fn lava_has_water_surface_heights_in_the_opaque_layer() {
        let mut padded = empty();
        for (state, height, lowered) in [
            (blocks::LAVA, 16, 1),
            (blocks::FLOWING_LAVA, 14, 0),
            (blocks::FLOWING_LAVA + 1, 12, 0),
            (blocks::FLOWING_LAVA + 2, 10, 0),
            (blocks::FALLING_LAVA, 16, 1),
        ] {
            padded[padded_index(5, 5, 5)] = state;
            padded[padded_index(6, 5, 5)] = state;
            let mut out = Vec::new();
            assert_eq!(mesh_section_layers(&padded, None, &mut out), [10, 0, 0]);
            let mut tops = 0;
            for vertex in out.as_chunks::<2>().0 {
                assert_eq!(vertex[1] & 4095, u32::from(blocks::info(state).tex[UP]));
                assert_eq!((vertex[1] >> 12) & 1, 0);
                if (vertex[0] >> 27) & 7 == UP as u32 {
                    assert_eq!(position(vertex)[1], 80 + height);
                    assert_eq!(vertex[1] >> 31, lowered);
                    tops += 1;
                }
            }
            assert_eq!(tops, 8);
        }
    }

    #[test]
    fn lowered_water_top_survives_opaque_cover_and_uses_cell_light_without_ao() {
        for y in [5, 15] {
            for above in [blocks::STONE, blocks::AIR, blocks::GLASS, blocks::WATER] {
                let mut p = empty();
                p[padded_index(5, y, 5)] = blocks::WATER;
                p[padded_index(5, y + 1, 5)] = above;
                // These edge blockers would darken an ordinary boundary face.
                p[padded_index(4, y + 1, 5)] = blocks::STONE;
                p[padded_index(5, y + 1, 4)] = blocks::STONE;
                let mut sky = vec![0; PADDED_LEN];
                let mut block = vec![2; PADDED_LEN];
                sky[padded_index(5, y, 5)] = 7;
                block[padded_index(5, y, 5)] = 11;
                let mut out = Vec::new();
                mesh_section_lit(&p, Some((&sky, &block)), &mut out);
                let top: Vec<_> = out
                    .chunks(WORDS_PER_QUAD)
                    .filter(|q| {
                        q[1] & 4095 == blocks::info(blocks::WATER).tex[UP] as u32
                            && (q[0] >> 27) & 7 == UP as u32
                            && q.chunks(2).all(|v| position(v)[1] == (y + 1) as u32 * 16)
                    })
                    .collect();
                assert_eq!(
                    top.len(),
                    usize::from(above != blocks::WATER),
                    "above={above}, y={y}"
                );
                for q in top {
                    for v in q.chunks(2) {
                        assert_eq!(v[1] >> 31, 1);
                        let height = position(v)[1] as f64 / 16.0 - 1.0 / 9.0;
                        assert!((height - y as f64 - 8.0 / 9.0).abs() < 1e-12);
                        assert_eq!((v[0] >> 30) & 3, 3);
                        assert_eq!((v[1] >> 13) & 15, 7);
                        assert_eq!((v[1] >> 17) & 15, 11);
                    }
                }
            }
        }
    }

    fn assert_water_strip(out: &[u32], cell: [i32; 3], face: usize, expected: usize) {
        let n = FACES[face].normal;
        let axis = if n[0] != 0 { 0 } else { 2 };
        let plane = (cell[axis] + i32::from(n[axis] > 0)) as u32 * 16;
        let top = (cell[1] + 1) as u32 * 16;
        let quads: Vec<_> = out
            .chunks(WORDS_PER_QUAD)
            .filter(|q| {
                (q[0] >> 27) & 7 == face as u32
                    && q.chunks(2).all(|v| {
                        let p = position(v);
                        p[axis] == plane && p[1] >= top - 16 && p[1] <= top
                    })
            })
            .collect();
        assert_eq!(quads.len(), expected, "cell {cell:?}, face {face}");
        for q in quads {
            let mut lower = 0;
            let points: Vec<_> = q
                .chunks(2)
                .map(|v| {
                    let p = position(v);
                    assert_eq!(p[1], top);
                    let drop = (v[1] >> 31) as f64 / 9.0;
                    lower += usize::from(drop != 0.0);
                    let y = p[1] as f64 / 16.0 - drop;
                    // Both raw V values are zero; the shader adds the same drop
                    // to V on side faces, cropping precisely the upper ninth.
                    assert_eq!((v[1] >> 26) & 31, 0);
                    let texture_v = ((v[1] >> 26) & 31) as f64 / 16.0 + drop;
                    assert!((texture_v - (cell[1] as f64 + 1.0 - y)).abs() < 1e-12);
                    assert_eq!((v[0] >> 30) & 3, 3);
                    assert_eq!((v[1] >> 13) & 15, 15);
                    assert_eq!((v[1] >> 17) & 15, 0);
                    [p[0] as f64 / 16.0, y, p[2] as f64 / 16.0]
                })
                .collect();
            assert_eq!(lower, 2);
            for tri in [[0, 1, 2], [0, 2, 3]] {
                let a: [f64; 3] = std::array::from_fn(|i| points[tri[1]][i] - points[tri[0]][i]);
                let b: [f64; 3] = std::array::from_fn(|i| points[tri[2]][i] - points[tri[0]][i]);
                let normal = [
                    a[1] * b[2] - a[2] * b[1],
                    a[2] * b[0] - a[0] * b[2],
                    a[0] * b[1] - a[1] * b[0],
                ];
                assert!((normal[axis] * n[axis] as f64 - 1.0 / 9.0).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn water_column_height_difference_emits_only_the_high_side_strip() {
        // Includes the reported (5,5,5)/(5,6,5)/(6,5,5) arrangement.
        for (face, direction) in FACES.iter().enumerate().skip(NORTH) {
            for y in [0, 5, 15] {
                for border in [false, true] {
                    let n = direction.normal;
                    let axis = if n[0] != 0 { 0 } else { 2 };
                    let mut cell = [5, y, 5];
                    if border {
                        cell[axis] = if n[axis] < 0 { 0 } else { 15 };
                    }
                    let neighbor: [i32; 3] = std::array::from_fn(|i| cell[i] + n[i]);
                    let mut p = empty();
                    p[padded_index(cell[0], y, cell[2])] = blocks::WATER;
                    p[padded_index(cell[0], y + 1, cell[2])] = blocks::WATER;
                    p[padded_index(neighbor[0], y, neighbor[2])] = blocks::WATER;
                    let mut out = Vec::new();
                    mesh_section(&p, &mut out);
                    assert_water_strip(&out, cell, face, 1);
                    if !border {
                        assert_water_strip(&out, neighbor, face ^ 1, 0);
                    }
                    // Two full-height neighboring cells must still cull.
                    p[padded_index(neighbor[0], y + 1, neighbor[2])] = blocks::WATER;
                    out.clear();
                    mesh_section(&p, &mut out);
                    assert_water_strip(&out, cell, face, 0);
                    if !border {
                        assert_water_strip(&out, neighbor, face ^ 1, 0);
                    }
                }
            }
        }
    }

    #[test]
    fn water_strip_matches_both_sections_at_a_top_horizontal_padding_corner() {
        let water = [[15, 15, 15], [15, 16, 15], [16, 15, 15]];
        for origin_x in [0, 16] {
            let mut p = empty();
            for [x, y, z] in water {
                let x = x - origin_x;
                if (-1..=16).contains(&x) {
                    p[padded_index(x, y, z)] = blocks::WATER;
                }
            }
            let mut out = Vec::new();
            mesh_section(&p, &mut out);
            if origin_x == 0 {
                assert_water_strip(&out, [15, 15, 15], EAST, 1);
            } else {
                assert_water_strip(&out, [0, 15, 15], WEST, 0);
            }
        }
    }

    #[test]
    fn layer_counts_and_material_boundaries() {
        for (a, b, expected) in [
            (blocks::GLASS, blocks::GLASS, [0, 10, 0]),
            (blocks::WATER, blocks::WATER, [0, 0, 10]),
            (blocks::OAK_LEAVES, blocks::OAK_LEAVES, [0, 10, 0]),
            (blocks::OAK_LEAVES, blocks::PLACED_OAK_LEAVES, [0, 10, 0]),
            (blocks::PLACED_OAK_LEAVES, blocks::OAK_LEAVES, [0, 10, 0]),
            (
                blocks::PLACED_OAK_LEAVES,
                blocks::PLACED_OAK_LEAVES,
                [0, 10, 0],
            ),
            (blocks::OAK_LEAVES, blocks::AIR, [0, 6, 0]),
            (blocks::OAK_LEAVES, blocks::GLASS, [0, 12, 0]),
            (blocks::GLASS, blocks::OAK_LEAVES, [0, 12, 0]),
            (blocks::STONE, blocks::GLASS, [6, 5, 0]),
            (blocks::GLASS, blocks::STONE, [6, 5, 0]),
            (blocks::STONE, blocks::WATER, [6, 0, 5]),
            (blocks::STONE, blocks::OAK_LEAVES, [6, 5, 0]),
            (blocks::OAK_LEAVES, blocks::STONE, [6, 5, 0]),
        ] {
            let mut p = empty();
            p[padded_index(3, 3, 3)] = a;
            p[padded_index(4, 3, 3)] = b;
            let mut out = Vec::new();
            assert_eq!(mesh_section_layers(&p, None, &mut out), expected);
            assert_eq!(
                out.len(),
                expected.iter().sum::<u32>() as usize * WORDS_PER_QUAD
            );
            // Same culling rules across a section boundary.
            p[padded_index(3, 3, 3)] = blocks::AIR;
            p[padded_index(4, 3, 3)] = blocks::AIR;
            p[padded_index(15, 3, 3)] = a;
            p[padded_index(16, 3, 3)] = b;
            out.clear();
            let count = if blocks::occludes(b) || expected.iter().sum::<u32>() == 10 {
                5
            } else {
                6
            };
            assert_eq!(mesh_section(&p, &mut out), count);
        }
        let mut p = empty();
        for (x, state) in [
            (2, blocks::WATER),
            (5, blocks::OAK_LEAVES),
            (8, blocks::STONE),
        ] {
            p[padded_index(x, 3, 3)] = state;
        }
        let mut out = Vec::new();
        assert_eq!(mesh_section_layers(&p, None, &mut out), [6, 6, 6]);
        for (quads, state) in out
            .chunks(48)
            .zip([blocks::STONE, blocks::OAK_LEAVES, blocks::WATER])
        {
            for &[position, material] in quads.as_chunks::<2>().0 {
                let face = ((position >> 27) & 7) as usize;
                assert_eq!(material & 4095, u32::from(blocks::info(state).tex[face]));
            }
        }
    }

    #[test]
    fn adjacent_leaves_have_no_internal_faces_in_any_direction() {
        for axis in 0..3 {
            let mut p = empty();
            let a = [5, 5, 5];
            let mut b = a;
            b[axis] += 1;
            for [x, y, z] in [a, b] {
                p[padded_index(x, y, z)] = blocks::OAK_LEAVES;
            }
            let mut out = Vec::new();
            assert_eq!(mesh_section_layers(&p, None, &mut out), [0, 10, 0]);
            let internal_faces = decode(&out)
                .iter()
                .filter(|quad| quad.iter().all(|v| v.pos[axis] == b[axis]))
                .count();
            assert_eq!(internal_faces, 0, "axis={axis}");
        }
    }

    #[test]
    fn transparent_solids_do_not_occlude_ao_or_light_samples() {
        for state in [blocks::GLASS, blocks::OAK_LEAVES, blocks::WATER] {
            let mut p = empty();
            p[padded_index(5, 5, 5)] = blocks::STONE;
            p[padded_index(4, 6, 4)] = state;
            let mut sky = vec![15; PADDED_LEN];
            sky[padded_index(4, 6, 4)] = 3;
            let block = vec![0; PADDED_LEN];
            let mut out = Vec::new();
            mesh_section_lit(&p, Some((&sky, &block)), &mut out);
            let v = out
                .chunks(2)
                .find(|v| {
                    v[0] & 511 == 5 * 16
                        && (v[0] >> 9) & 511 == 6 * 16
                        && (v[0] >> 18) & 511 == 5 * 16
                        && (v[0] >> 27) & 7 == UP as u32
                })
                .unwrap();
            assert_eq!((v[0] >> 30) & 3, 3);
            assert_eq!((v[1] >> 13) & 15, 12);
        }
        // Glass fully enclosed by opaque cubes has no faces of its own.
        let mut p = vec![blocks::STONE; PADDED_LEN];
        p[padded_index(5, 5, 5)] = blocks::GLASS;
        let mut out = Vec::new();
        mesh_section(&p, &mut out);
        let glass: Vec<_> = out.chunks(2).filter(|v| v[1] & 4095 == 12).collect();
        assert!(glass.is_empty());
        assert_eq!(mesh_section_layers(&p, None, &mut Vec::new())[1], 0);
    }

    #[derive(Debug, Clone, Copy, PartialEq)]
    struct V {
        pos: [i32; 3],
        face: usize,
        ao: u32,
        uv: (u32, u32),
        layer: u32,
        tint: bool,
    }

    fn decode(out: &[u32]) -> Vec<[V; 4]> {
        out.chunks(8)
            .map(|q| {
                let v = |i: usize| {
                    let (a, b) = (q[i * 2], q[i * 2 + 1]);
                    V {
                        pos: [
                            (a & 511) as i32 / 16,
                            ((a >> 9) & 511) as i32 / 16,
                            ((a >> 18) & 511) as i32 / 16,
                        ],
                        face: ((a >> 27) & 7) as usize,
                        ao: (a >> 30) & 3,
                        uv: (((b >> 21) & 31) / 16, ((b >> 26) & 31) / 16),
                        layer: b & 0xFFF,
                        tint: (b >> 12) & 1 == 1,
                    }
                };
                [v(0), v(1), v(2), v(3)]
            })
            .collect()
    }

    fn sub(a: [i32; 3], b: [i32; 3]) -> [i32; 3] {
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    }

    fn cross(a: [i32; 3], b: [i32; 3]) -> [i32; 3] {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    }

    #[test]
    fn smooth_light_averages_outside_cells_and_excludes_opaque_samples() {
        let mut p = empty();
        p[padded_index(5, 5, 5)] = blocks::STONE;
        let mut sky = vec![15; PADDED_LEN];
        let mut block = vec![0; PADDED_LEN];
        let mut out = Vec::new();
        mesh_section_lit(&p, Some((&sky, &block)), &mut out);
        assert!(out.chunks(2).all(|v| (v[1] >> 13) & 15 == 15));
        // Lower x/z vertex on the top face touches these four exterior cells.
        for (x, z, v) in [(5, 5, 12), (4, 5, 8), (5, 4, 4), (4, 4, 0)] {
            sky[padded_index(x, 6, z)] = v;
            block[padded_index(x, 6, z)] = 15 - v;
        }
        let vertex = |out: &[u32]| -> u32 {
            out.chunks(2)
                .find(|v| {
                    v[0] & 511 == 5 * 16
                        && (v[0] >> 9) & 511 == 6 * 16
                        && (v[0] >> 18) & 511 == 5 * 16
                        && (v[0] >> 27) & 7 == UP as u32
                })
                .unwrap()[1]
        };
        out.clear();
        mesh_section_lit(&p, Some((&sky, &block)), &mut out);
        assert_eq!((vertex(&out) >> 13) & 15, 6);
        assert_eq!((vertex(&out) >> 17) & 15, 9);
        p[padded_index(4, 6, 4)] = blocks::STONE;
        out.clear();
        mesh_section_lit(&p, Some((&sky, &block)), &mut out);
        assert_eq!((vertex(&out) >> 13) & 15, 8);
        assert_eq!((vertex(&out) >> 17) & 15, 7);
        // Adjacent to a lamp, a lit exterior face keeps block light at night.
        p[padded_index(4, 6, 4)] = blocks::LAMP_BLOCK;
        sky.fill(0);
        block.fill(14);
        out.clear();
        mesh_section_lit(&p, Some((&sky, &block)), &mut out);
        assert_eq!((vertex(&out) >> 13) & 15, 0);
        assert_eq!((vertex(&out) >> 17) & 15, 14);
    }

    #[test]
    fn lone_block_has_six_outward_facing_fully_lit_quads() {
        let mut p = empty();
        p[padded_index(5, 6, 7)] = blocks::GRASS_BLOCK;
        let mut out = Vec::new();
        assert_eq!(mesh_section(&p, &mut out), 6);
        let quads = decode(&out);
        let mut faces_seen = [false; 6];
        for q in &quads {
            let f = q[0].face;
            faces_seen[f] = true;
            // Both triangles (0,1,2) and (0,2,3) wind counter-clockwise around the outward normal.
            for tri in [[0, 1, 2], [0, 2, 3]] {
                let n = cross(
                    sub(q[tri[1]].pos, q[tri[0]].pos),
                    sub(q[tri[2]].pos, q[tri[0]].pos),
                );
                assert_eq!(n, FACES[f].normal, "face {f} winding");
            }
            // The four corners carry the four distinct texture corners.
            let mut uvs: Vec<_> = q.iter().map(|v| v.uv).collect();
            uvs.sort();
            assert_eq!(uvs, vec![(0, 0), (0, 1), (1, 0), (1, 1)]);
            assert!(q.iter().all(|v| v.ao == 3));
            assert!(out.chunks(2).all(|v| (v[1] >> 13) & 255 == 15));
            for v in q {
                for axis in 0..3 {
                    let base = [5, 6, 7][axis];
                    assert!(v.pos[axis] == base || v.pos[axis] == base + 1);
                }
            }
        }
        assert_eq!(faces_seen, [true; 6]);
        // Both the turf and the fringe on the side use the biome colour.
        let layer_of = |f: usize| quads.iter().find(|q| q[0].face == f).unwrap()[0];
        assert_eq!((layer_of(DOWN).layer, layer_of(DOWN).tint), (3, false));
        assert_eq!((layer_of(UP).layer, layer_of(UP).tint), (1, true));
        assert_eq!((layer_of(EAST).layer, layer_of(EAST).tint), (2, true));
    }

    #[test]
    fn side_faces_keep_the_texture_upright() {
        let mut p = empty();
        p[padded_index(0, 0, 0)] = blocks::OAK_LOG;
        let mut out = Vec::new();
        mesh_section(&p, &mut out);
        for q in decode(&out) {
            if q[0].face >= NORTH {
                for v in q {
                    // Top edge of the block (y = 1) maps to the top row of the texture (v = 0).
                    assert_eq!(v.uv.1, 1 - v.pos[1] as u32);
                }
            }
        }
    }

    #[test]
    fn touching_faces_are_culled_including_across_the_section_border() {
        let mut p = empty();
        p[padded_index(3, 3, 3)] = blocks::STONE;
        p[padded_index(4, 3, 3)] = blocks::STONE;
        let mut out = Vec::new();
        assert_eq!(mesh_section(&p, &mut out), 10);

        // A neighbour in the padding (outside the section) hides the face too,
        // but is not meshed itself.
        let mut p = empty();
        p[padded_index(0, 0, 0)] = blocks::STONE;
        p[padded_index(-1, 0, 0)] = blocks::STONE;
        let mut out = Vec::new();
        assert_eq!(mesh_section(&p, &mut out), 5);
        assert!(decode(&out).iter().all(|q| q[0].face != WEST));
    }

    #[test]
    fn ambient_occlusion_levels() {
        // A floor with one block standing on it: the floor's top face next to
        // the pillar gets darker corners where it touches.
        let mut p = empty();
        for z in 0..3 {
            for x in 0..3 {
                p[padded_index(x, 0, z)] = blocks::STONE;
            }
        }
        p[padded_index(1, 1, 1)] = blocks::STONE;
        let mut out = Vec::new();
        mesh_section(&p, &mut out);
        let quads = decode(&out);
        let top_at = |x: i32, z: i32| -> [V; 4] {
            *quads
                .iter()
                .find(|q| {
                    q[0].face == UP
                        && q.iter().map(|v| v.pos[0]).min() == Some(x)
                        && q.iter().map(|v| v.pos[2]).min() == Some(z)
                        && q[0].pos[1] == 1
                })
                .unwrap()
        };
        // Edge-adjacent floor tile (0,1): the two vertices on the pillar side see one solid side.
        let q = top_at(0, 1);
        for v in q {
            let expected = if v.pos[0] == 1 { 2 } else { 3 };
            assert_eq!(v.ao, expected, "{v:?}");
        }
        // Diagonal floor tile (0,0): only the shared corner vertex is darkened.
        let q = top_at(0, 0);
        for v in q {
            let expected = if v.pos[0] == 1 && v.pos[2] == 1 { 2 } else { 3 };
            assert_eq!(v.ao, expected, "{v:?}");
        }
        // The diagonal split avoids the single dark corner: triangle 0-2 edge
        // must connect the two vertices with the larger AO sum.
        assert!(q[0].ao + q[2].ao >= q[1].ao + q[3].ao);

        // An inner corner (two walls) closes fully: level 0.
        let mut p = empty();
        p[padded_index(1, 0, 1)] = blocks::STONE;
        p[padded_index(0, 1, 1)] = blocks::STONE;
        p[padded_index(1, 1, 0)] = blocks::STONE;
        let mut out = Vec::new();
        mesh_section(&p, &mut out);
        let quads = decode(&out);
        let top = quads
            .iter()
            .find(|q| q[0].face == UP && q[0].pos[1] == 1)
            .unwrap();
        let dark = top.iter().find(|v| v.pos[0] == 1 && v.pos[2] == 1).unwrap();
        assert_eq!(dark.ao, 0);
    }

    #[test]
    fn full_section_only_shows_its_shell() {
        let mut p = empty();
        for y in 0..16 {
            for z in 0..16 {
                for x in 0..16 {
                    p[padded_index(x, y, z)] = blocks::STONE;
                }
            }
        }
        let mut out = Vec::new();
        assert_eq!(mesh_section(&p, &mut out), 6 * 256);
        assert_eq!(out.len(), 6 * 256 * WORDS_PER_QUAD);
    }
}
