//! Turns one 16x16x16 section into quads.
//!
//! Like the game, every visible block face is its own quad (no greedy
//! merging): per-vertex ambient occlusion and, later, per-vertex light make
//! neighbouring faces differ.
//!
//! Vertex layout, two `u32` per vertex:
//! ```text
//! word 0: x:5 | y:5 | z:5 | face:3 | ao:2 | u:1 | v:1     (x, y, z in 0..=16)
//! word 1: texture layer:12 | tint:1
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

/// Texture coordinates of a block corner (each component 0 or 1) on a face.
/// Side faces keep "up" at v = 0 and are not mirrored when seen from outside.
#[inline]
fn uv(face: usize, p: [i32; 3]) -> (u32, u32) {
    let (u, v) = match face {
        DOWN => (p[0], 1 - p[2]),
        UP => (p[0], p[2]),
        NORTH => (1 - p[0], 1 - p[1]),
        SOUTH => (p[0], 1 - p[1]),
        WEST => (p[2], 1 - p[1]),
        _ => (1 - p[2], 1 - p[1]),
    };
    (u as u32, v as u32)
}

/// Meshes a section from its padded block array and appends vertex words to
/// `out`. Returns the number of quads.
///
/// Ambient occlusion levels 0..=3 count how open a vertex is: the two edge
/// neighbours and the diagonal one, where two solid edges also close the
/// diagonal. Mapped to 0.4/0.6/0.8/1.0 brightness this equals averaging the
/// game's 0.2 shade of opaque cubes over the four blocks touching a vertex.
pub fn mesh_section(padded: &[BlockState], out: &mut Vec<u32>) -> u32 {
    assert_eq!(padded.len(), PADDED_LEN);
    let mut quads = 0u32;
    for y in 0..16i32 {
        for z in 0..16i32 {
            for x in 0..16i32 {
                let state = padded[padded_index(x, y, z)];
                if state == blocks::AIR {
                    continue;
                }
                let info = blocks::info(state);
                for (f, face) in FACES.iter().enumerate() {
                    let n = face.normal;
                    let (ax, ay, az) = (x + n[0], y + n[1], z + n[2]);
                    if blocks::is_opaque(padded[padded_index(ax, ay, az)]) {
                        continue;
                    }

                    let mut words = [[0u32; 2]; 4];
                    let mut ao = [0u32; 4];
                    for (k, &(i, j)) in CORNERS.iter().enumerate() {
                        let (si, sj) = (2 * i - 1, 2 * j - 1);
                        let solid = |d: [i32; 3]| -> bool {
                            blocks::is_opaque(padded[padded_index(ax + d[0], ay + d[1], az + d[2])])
                        };
                        let side1 = solid([face.b[0] * si, face.b[1] * si, face.b[2] * si]);
                        let side2 = solid([face.c[0] * sj, face.c[1] * sj, face.c[2] * sj]);
                        let corner = solid([
                            face.b[0] * si + face.c[0] * sj,
                            face.b[1] * si + face.c[1] * sj,
                            face.b[2] * si + face.c[2] * sj,
                        ]);
                        ao[k] = if side1 && side2 {
                            0
                        } else {
                            3 - (side1 as u32 + side2 as u32 + corner as u32)
                        };

                        // Corner position inside the unit cube.
                        let on = |axis: usize| -> i32 {
                            if n[axis] != 0 {
                                (n[axis] > 0) as i32
                            } else {
                                face.b[axis] * i + face.c[axis] * j
                            }
                        };
                        let p = [on(0), on(1), on(2)];
                        let (u, v) = uv(f, p);
                        words[k][0] = (x + p[0]) as u32
                            | ((y + p[1]) as u32) << 5
                            | ((z + p[2]) as u32) << 10
                            | (f as u32) << 15
                            | ao[k] << 18
                            | u << 20
                            | v << 21;
                        words[k][1] = info.tex[f] as u32 | (info.tint[f] as u32) << 12;
                    }

                    // Split along the brighter diagonal so shading is symmetric.
                    let start = if ao[0] + ao[2] >= ao[1] + ao[3] { 0 } else { 1 };
                    for k in 0..4 {
                        let w = words[(start + k) % 4];
                        out.push(w[0]);
                        out.push(w[1]);
                    }
                    quads += 1;
                }
            }
        }
    }
    quads
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> Vec<BlockState> {
        vec![blocks::AIR; PADDED_LEN]
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
                            (a & 31) as i32,
                            ((a >> 5) & 31) as i32,
                            ((a >> 10) & 31) as i32,
                        ],
                        face: ((a >> 15) & 7) as usize,
                        ao: (a >> 18) & 3,
                        uv: ((a >> 20) & 1, (a >> 21) & 1),
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
            for v in q {
                for axis in 0..3 {
                    let base = [5, 6, 7][axis];
                    assert!(v.pos[axis] == base || v.pos[axis] == base + 1);
                }
            }
        }
        assert_eq!(faces_seen, [true; 6]);
        // Grass: dirt below, tinted grayscale top, side texture around.
        let layer_of = |f: usize| quads.iter().find(|q| q[0].face == f).unwrap()[0];
        assert_eq!((layer_of(DOWN).layer, layer_of(DOWN).tint), (3, false));
        assert_eq!((layer_of(UP).layer, layer_of(UP).tint), (1, true));
        assert_eq!((layer_of(EAST).layer, layer_of(EAST).tint), (2, false));
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
