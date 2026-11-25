//! World-aligned feature plots. A tree is a pure description; chunks only clip it.
use jmath::mix_stafford13;
use std::collections::VecDeque;
use world::{
    biomes::{TreeShape, BIOMES},
    blocks, BlockState, Chunk, HEIGHT, MIN_Y,
};

use crate::{entrances::Entrance, TerrainGenerator, SEA_LEVEL};

pub(crate) const PLOT_SIZE: i32 = 4;
pub(crate) const MAX_CROWN_RADIUS: i32 = 3;
const _: () = assert!(MAX_CROWN_RADIUS <= 3 && MAX_CROWN_RADIUS < PLOT_SIZE);
const EXIT_CLEARANCE: i32 = 3;
// The root and far edge of its crown can both extend beyond this chunk.
pub(crate) const TREE_ENTRANCE_HALO: i32 = 2 * MAX_CROWN_RADIUS + EXIT_CLEARANCE;
const CROWN_WIDTH: usize = (2 * MAX_CROWN_RADIUS + 1) as usize;
const TREE_SALT: u64 = 0x19ac_62e7_d403_b58f;

fn plot_hash(seed: i64, qx: i32, qz: i32) -> u64 {
    let h = mix_stafford13(seed as u64 ^ TREE_SALT);
    let h = mix_stafford13(h ^ (qx as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));
    mix_stafford13(h ^ (qz as u64).wrapping_mul(0xc2b2_ae3d_27d4_eb4f))
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    x: i32,
    z: i32,
    r: f64,
    variation: u64,
}
impl Candidate {
    fn new(seed: i64, qx: i32, qz: i32) -> Self {
        let h = plot_hash(seed, qx, qz);
        let variation = mix_stafford13(h);
        Self {
            x: qx * PLOT_SIZE + (variation & 3) as i32,
            z: qz * PLOT_SIZE + ((variation >> 2) & 3) as i32,
            r: (h >> 11) as f64 * (1.0 / (1u64 << 53) as f64),
            variation: mix_stafford13(variation),
        }
    }
}

#[derive(Debug)]
struct Tree {
    root: Candidate,
    top: i32,
    height: i32,
    shape: TreeShape,
    tip: i32,
    large: bool,
    legacy: bool,
}

impl Tree {
    fn new(root: Candidate, top: i32, shape: TreeShape, [min, max]: [u8; 2]) -> Self {
        let size = mix_stafford13(root.variation ^ 0x834e_06a7_d1c2_5fb9);
        let large = shape == TreeShape::Round && size.is_multiple_of(40);
        let height = if large {
            i32::from(max) + 3 + (size / 40 % 3) as i32
        } else {
            Self::normal_height(root, [min, max])
        };
        let tip = if shape == TreeShape::Cone {
            1 + ((root.variation >> 8) & 1) as i32
        } else {
            1
        };
        Self {
            root,
            top,
            height,
            shape,
            tip,
            large,
            legacy: false,
        }
    }

    fn normal_height(root: Candidate, [min, max]: [u8; 2]) -> i32 {
        i32::from(min) + (root.variation % u64::from(max - min + 1)) as i32
    }

    fn fits_world(&self) -> bool {
        self.top + self.height + self.tip < MIN_Y + HEIGHT
    }

    fn obstructs(
        &self,
        entrances: &[Entrance],
        protected: fn(&Entrance, i32, i32, i32) -> bool,
    ) -> bool {
        let mut obstructs = false;
        self.blocks(|x, y, z, _| {
            obstructs |= entrances.iter().any(|e| protected(e, x, y, z));
        });
        obstructs
    }

    fn obstructs_exit(entrance: &Entrance, x: i32, y: i32, z: i32) -> bool {
        if entrance.contains(x, y, z) {
            return true;
        }
        // Check towards the passage so the tree also leaves room to land
        // just outside the opening.
        let dx = entrance.root[0] - x;
        let dz = entrance.root[2] - z;
        let (step_x, step_z) = if dx.abs() >= dz.abs() {
            (dx.signum(), 0)
        } else {
            (0, dz.signum())
        };
        (1..=EXIT_CLEARANCE).any(|step| entrance.contains(x + step_x * step, y, z + step_z * step))
    }

    fn blocks(&self, mut emit: impl FnMut(i32, i32, i32, BlockState)) {
        let mut put = |dx: i32, y, dz: i32, state| {
            debug_assert!(dx.abs() <= MAX_CROWN_RADIUS && dz.abs() <= MAX_CROWN_RADIUS);
            emit(self.root.x + dx, y, self.root.z + dz, state);
        };
        let crown = self.top + self.height;
        for y in self.top + 1..=crown {
            put(0, y, 0, blocks::OAK_LOG);
        }
        if self.legacy {
            self.legacy_crown(crown, &mut put);
            return;
        }
        match self.shape {
            TreeShape::Round => {
                let radii = self.round_radii();
                let bottom = crown + 2 - radii.len() as i32;
                for (dy, &radius) in radii.iter().enumerate() {
                    self.crown_layer(bottom + dy as i32, crown, radius, true, &mut put);
                }
                if self.height >= 7 || self.large {
                    self.branches(bottom, &mut put);
                }
            }
            TreeShape::Cone => {
                let profile = mix_stafford13(self.root.variation ^ 0x1bf5_902e_76ac_43d8);
                let width = if profile & 1 == 0 {
                    3
                } else {
                    1 + ((profile >> 1) & 1) as i32
                };
                let depth = self.height / 2 + 1;
                for dy in 0..=depth {
                    let taper = (width * (depth - dy) + depth - 1) / depth;
                    let radius = (taper - dy % 2).max(0);
                    self.crown_layer(crown - depth + dy, crown, radius, false, &mut put);
                }
                for dy in 1..=self.tip {
                    put(0, crown + dy, 0, blocks::OAK_LEAVES);
                }
            }
            TreeShape::Broad => {
                let depth =
                    (mix_stafford13(self.root.variation ^ 0xc46a_3758_9db1_02ef) & 1) as i32;
                for y in crown - depth..=crown {
                    self.crown_layer(y, crown, 3, true, &mut put);
                }
                self.crown_layer(crown + 1, crown, 2, true, &mut put);
            }
            TreeShape::None => unreachable!(),
        }
    }

    fn round_radii(&self) -> &[i32] {
        if self.large {
            let radii = &[1, 2, 3, 3, 3, 3, 2, 1];
            // Leave room below the crown for branches even with the
            // shortest permitted registry heights.
            &radii[radii.len().saturating_sub((self.height - 1) as usize)..]
        } else if self.height >= 6 {
            &[1, 2, 3, 3, 2, 1]
        } else {
            &[1, 2, 2, 1]
        }
    }

    fn blocks_above_ground(
        &self,
        mut height_at: impl FnMut(i32, i32) -> i32,
        mut emit: impl FnMut(i32, i32, i32, BlockState),
    ) {
        let bottom = self.top
            + match (self.shape, self.legacy) {
                (TreeShape::Cone, true) => 1 + self.height / 2,
                (_, true) => self.height - 2,
                (TreeShape::Cone, false) => self.height - self.height / 2 - 1,
                (TreeShape::Broad, false) => self.height - 1,
                (TreeShape::Round, false) => {
                    let crown_depth = self.round_radii().len() as i32;
                    let branch_depth = if self.height >= 7 || self.large { 2 } else { 0 };
                    self.height + 2 - crown_depth - branch_depth
                }
                (TreeShape::None, false) => unreachable!(),
            };
        let x0 = self.root.x - MAX_CROWN_RADIUS;
        let z0 = self.root.z - MAX_CROWN_RADIUS;
        let y0 = self.top + 1;
        let heights: [[i32; CROWN_WIDTH]; CROWN_WIDTH] = std::array::from_fn(|z| {
            std::array::from_fn(|x| height_at(x0 + x as i32, z0 + z as i32))
        });
        if heights.iter().flatten().all(|&height| height < bottom) {
            self.blocks(emit);
            return;
        }

        // A slope may cut a face path through a crown. Start at every
        // placeable log and emit only the leaves it can still support.
        let mut cells =
            vec![[[blocks::AIR; CROWN_WIDTH]; CROWN_WIDTH]; (self.height + self.tip) as usize];
        let mut queue = VecDeque::new();
        self.blocks(|x, y, z, state| {
            let [ix, iy, iz] = [(x - x0) as usize, (y - y0) as usize, (z - z0) as usize];
            if y <= heights[iz][ix] {
                return;
            }
            let cell = &mut cells[iy][iz][ix];
            if *cell != blocks::OAK_LOG {
                *cell = state;
                if state == blocks::OAK_LOG {
                    emit(x, y, z, state);
                    queue.push_back(([ix as i32, iy as i32, iz as i32], 0));
                }
            }
        });
        while let Some(([x, y, z], distance)) = queue.pop_front() {
            if distance == 6 {
                continue;
            }
            for [nx, ny, nz] in [
                [x - 1, y, z],
                [x + 1, y, z],
                [x, y - 1, z],
                [x, y + 1, z],
                [x, y, z - 1],
                [x, y, z + 1],
            ] {
                if let Some(cell) = cells
                    .get_mut(ny as usize)
                    .and_then(|layer| layer.get_mut(nz as usize))
                    .and_then(|row| row.get_mut(nx as usize))
                    .filter(|cell| **cell == blocks::OAK_LEAVES)
                {
                    *cell = blocks::AIR;
                    emit(x0 + nx, y0 + ny, z0 + nz, blocks::OAK_LEAVES);
                    queue.push_back(([nx, ny, nz], distance + 1));
                }
            }
        }
    }

    // Keep the original footprint for tree eligibility beside entrances and
    // for trees that need it to leave the exit clear.
    fn legacy_crown(&self, crown: i32, put: &mut impl FnMut(i32, i32, i32, BlockState)) {
        let mut layer = |y: i32, radius: i32, cross: bool| {
            for dz in -radius..=radius {
                for dx in -radius..=radius {
                    let corner = dx.abs() == radius && dz.abs() == radius;
                    let bit =
                        ((dx + 2) + (dz + 2) * 5 + (y - crown + 3) * 25).rem_euclid(64) as u32;
                    if (cross && dx.abs() + dz.abs() > radius)
                        || (radius == 2 && corner && self.root.variation.rotate_right(bit) & 1 == 0)
                    {
                        continue;
                    }
                    put(dx, y, dz, blocks::OAK_LEAVES);
                }
            }
        };
        if self.shape == TreeShape::Cone {
            let start = self.top + 1 + self.height / 2;
            for y in start..=crown {
                let radius = (2 - (y - start) % 3).min((crown - y + 1) / 2);
                layer(y, radius, (y & 1) == (self.root.variation & 1) as i32);
            }
            for dy in 1..=self.tip {
                layer(crown + dy, 0, false);
            }
        } else {
            for (dy, radius, cross) in [(-2, 2, false), (-1, 2, false), (0, 1, false), (1, 1, true)]
            {
                layer(crown + dy, radius, cross);
            }
        }
    }

    fn crown_layer(
        &self,
        y: i32,
        crown: i32,
        radius: i32,
        sparse: bool,
        put: &mut impl FnMut(i32, i32, i32, BlockState),
    ) {
        let outer = radius * (radius + 1);
        // Keep the radius-one cross intact. Every outer cell touches the
        // retained inner disk by a face, even if its outer neighbours are gone.
        let inner = ((radius - 1) * radius).max(1);
        let layer_key = ((y - crown + 8) as u64) << 6;
        for dz in -radius..=radius {
            for dx in -radius..=radius {
                let distance = dx * dx + dz * dz;
                if distance > outer {
                    continue;
                }
                if sparse && distance > inner {
                    let cell = layer_key | ((dz + 3) as u64) << 3 | (dx + 3) as u64;
                    if mix_stafford13(self.root.variation ^ cell) & 3 == 0 {
                        continue;
                    }
                }
                put(dx, y, dz, blocks::OAK_LEAVES);
            }
        }
    }

    fn branches(&self, bottom: i32, put: &mut impl FnMut(i32, i32, i32, BlockState)) {
        let style = mix_stafford13(self.root.variation ^ 0x742d_6c0b_a9f1_358e);
        let count = if self.large { 2 + style % 2 } else { style % 3 };
        let start = ((style >> 8) & 3) as usize;
        let directions = [(1, 0), (0, 1), (-1, 0), (0, -1)];
        for branch in 0..count as usize {
            let (dx, dz) = directions[(start + branch) % directions.len()];
            let bits = style >> (12 + 2 * branch);
            let length = 1 + (bits & 1) as i32;
            let y = bottom - 1 - ((bits >> 1) & 1) as i32;
            for step in 1..=length {
                put(dx * step, y, dz * step, blocks::OAK_LOG);
            }
            let (x, z) = (dx * length, dz * length);
            for oz in -1..=1_i32 {
                for ox in -1..=1_i32 {
                    put(x + ox, y, z + oz, blocks::OAK_LEAVES);
                    if ox.abs() + oz.abs() <= 1 {
                        put(x + ox, y + 1, z + oz, blocks::OAK_LEAVES);
                    }
                }
            }
        }
    }
}

impl TerrainGenerator {
    fn tree(
        &self,
        root: Candidate,
        entrances: &[Entrance],
        mut height_at: impl FnMut(i32, i32) -> i32,
    ) -> Option<Tree> {
        let top = height_at(root.x, root.z);
        if top <= SEA_LEVEL {
            return None;
        }
        let b = &BIOMES[self.biome_for_height(root.x, root.z, top) as usize];
        if root.r >= b.tree_density || b.tree_shape == TreeShape::None {
            return None;
        }
        let steep = [
            (root.x - 1, root.z),
            (root.x + 1, root.z),
            (root.x, root.z - 1),
            (root.x, root.z + 1),
        ]
        .into_iter()
        .any(|(x, z)| (height_at(x, z) - top).abs() >= 3);
        if steep
            || ![blocks::GRASS_BLOCK, blocks::COARSE_DIRT, blocks::SNOW_BLOCK].contains(&b.surface)
            || Self::coating(b, top, top, steep) != b.surface
        {
            return None;
        }
        let neighbors = [
            (root.x - 1, root.z),
            (root.x + 1, root.z),
            (root.x, root.z - 1),
            (root.x, root.z + 1),
        ]
        .map(|(x, z)| height_at(x, z));
        if self
            .caves
            .is_cave(root.x, top, root.z, top, neighbors)
            .is_some()
            || entrances.iter().any(|e| e.contains(root.x, top, root.z))
        {
            return None;
        }
        let tree = Tree::new(root, top, b.tree_shape, b.tree_height);
        if entrances.is_empty() && tree.fits_world() {
            return Some(tree);
        }

        let legacy = Tree {
            height: Tree::normal_height(root, b.tree_height),
            large: false,
            legacy: true,
            ..tree
        };
        if !legacy.fits_world()
            || (!entrances.is_empty() && legacy.obstructs(entrances, Entrance::contains))
        {
            return None;
        }
        if !tree.fits_world()
            || (!entrances.is_empty() && tree.obstructs(entrances, Tree::obstructs_exit))
        {
            return Some(legacy);
        }
        Some(tree)
    }

    pub(crate) fn plant_trees(
        &self,
        chunk: &mut Chunk,
        cx: i32,
        cz: i32,
        entrances: &[Entrance],
        mut local_height: impl FnMut(i32, i32) -> i32,
    ) {
        let mut height_at = |x, z| local_height(x - cx * 16, z - cz * 16);
        let max_density = BIOMES.iter().map(|b| b.tree_density).fold(0.0, f64::max);
        // Four interior plots plus one halo plot on each side: exactly 6 x 6.
        for qz in cz * 4 - 1..=cz * 4 + 4 {
            for qx in cx * 4 - 1..=cx * 4 + 4 {
                let root = Candidate::new(self.seed, qx, qz);
                let (x, z) = (root.x - cx * 16, root.z - cz * 16);
                if root.r >= max_density
                    || !(-MAX_CROWN_RADIUS..16 + MAX_CROWN_RADIUS).contains(&x)
                    || !(-MAX_CROWN_RADIUS..16 + MAX_CROWN_RADIUS).contains(&z)
                {
                    continue;
                }
                if let Some(tree) = self.tree(root, entrances, &mut height_at) {
                    tree.blocks_above_ground(&mut height_at, |x, y, z, state| {
                        let (x, z) = (x - cx * 16, z - cz * 16);
                        if (0..16).contains(&x) && (0..16).contains(&z) {
                            let old = chunk.get(x as usize, y, z as usize);
                            if old == blocks::AIR
                                || (state == blocks::OAK_LOG && old == blocks::OAK_LEAVES)
                            {
                                chunk.set(x as usize, y, z as usize, state);
                            }
                        }
                    });
                }
            }
        }
    }

    #[cfg(test)]
    fn tree_blocks(&self, qx: i32, qz: i32) -> Vec<(i32, i32, i32, BlockState)> {
        let mut result = Vec::new();
        let root = Candidate::new(self.seed, qx, qz);
        let entrances = self.entrances_for_chunk(
            root.x.div_euclid(16),
            root.z.div_euclid(16),
            TREE_ENTRANCE_HALO,
        );
        let mut surface = self.surface_sampler();
        if let Some(tree) = self.tree(root, &entrances, &mut surface) {
            tree.blocks_above_ground(surface, |x, y, z, state| result.push((x, y, z, state)));
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn generated_tree_shapes_have_leaf_paths_to_logs_within_six_steps() {
        let mut trees = 0;
        for seed in [2026, 0, -71] {
            let terrain = TerrainGenerator::new(seed);
            for qz in -12..16 {
                for qx in -12..16 {
                    let emitted = terrain.tree_blocks(qx, qz);
                    if emitted.is_empty() {
                        continue;
                    }
                    trees += 1;
                    assert_leaf_paths(emitted, (seed, qx, qz));
                }
            }
        }
        assert!(trees > 100);
        for shape in [TreeShape::Round, TreeShape::Cone, TreeShape::Broad] {
            for variation in 0..128 {
                for height in 3..=12 {
                    let tree = sample_tree(shape, height, variation);
                    let mut emitted = Vec::new();
                    tree.blocks(|x, y, z, state| emitted.push((x, y, z, state)));
                    assert_leaf_paths(emitted, (shape, height, variation));
                }
            }
        }
    }

    fn assert_leaf_paths(
        emitted: impl IntoIterator<Item = (i32, i32, i32, BlockState)>,
        context: impl std::fmt::Debug,
    ) {
        // Match placement precedence where the logs and leaves overlap.
        let mut blocks = BTreeMap::new();
        let mut queue = VecDeque::new();
        for (x, y, z, state) in emitted {
            let pos = [x, y, z];
            if state == blocks::OAK_LOG {
                blocks.insert(pos, 0);
                queue.push_back((pos, 0));
            } else {
                blocks.entry(pos).or_insert(7);
            }
        }
        while let Some(([x, y, z], distance)) = queue.pop_front() {
            if distance == 6 {
                continue;
            }
            for pos in [
                [x - 1, y, z],
                [x + 1, y, z],
                [x, y - 1, z],
                [x, y + 1, z],
                [x, y, z - 1],
                [x, y, z + 1],
            ] {
                if let Some(steps @ 7) = blocks.get_mut(&pos) {
                    *steps = distance + 1;
                    queue.push_back((pos, *steps));
                }
            }
        }
        for (pos, steps) in blocks {
            assert!(steps <= 6, "{context:?}, leaf={pos:?}");
        }
    }

    #[test]
    fn slopes_cannot_leave_an_isolated_leaf() {
        let isolated = (2, 104, 16, blocks::OAK_LEAVES);
        let tree = (0..128)
            .map(|variation| sample_tree(TreeShape::Broad, 4, variation))
            .find(|tree| {
                let mut reaches_edge = false;
                tree.blocks(|x, y, z, state| reaches_edge |= (x, y, z, state) == isolated);
                reaches_edge
            })
            .unwrap();
        let mut emitted = Vec::new();
        tree.blocks_above_ground(
            |x, z| {
                if x <= tree.root.x || (x, z) == (2, 16) {
                    100
                } else {
                    105
                }
            },
            |x, y, z, state| emitted.push((x, y, z, state)),
        );
        assert!(!emitted.contains(&isolated));
        assert!(emitted
            .iter()
            .any(|&(_, _, _, state)| state == blocks::OAK_LEAVES));
        assert_leaf_paths(emitted, "crown clipped by a slope");
    }

    #[test]
    fn plots_match_chunk_blocks_across_borders_and_generation_orders() {
        const { assert!(MAX_CROWN_RADIUS <= 3 && MAX_CROWN_RADIUS < PLOT_SIZE) };
        let mut crossed = 0;
        let mut logs = 0;
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let mut expected = BTreeMap::new();
            for cz in -2..=2 {
                for cx in -2..=2 {
                    expected.insert((cx, cz), t.generate_geology(cx, cz));
                }
            }
            // Reference enumerates a full extra chunk of roots, independently of
            // the production halo, and resolves all block conflicts in reverse order.
            let mut all_blocks = Vec::new();
            for qz in -12..16 {
                for qx in -12..16 {
                    let root = Candidate::new(seed, qx, qz);
                    let blocks = t.tree_blocks(qx, qz);
                    if !blocks.is_empty() {
                        let top = t.surface_y(root.x, root.z);
                        let biome = &BIOMES[t.biome_at(root.x, root.z) as usize];
                        assert!(top > SEA_LEVEL);
                        assert!(
                            [blocks::GRASS_BLOCK, blocks::COARSE_DIRT, blocks::SNOW_BLOCK]
                                .contains(&biome.surface)
                        );
                        for (x, z) in [
                            (root.x - 1, root.z),
                            (root.x + 1, root.z),
                            (root.x, root.z - 1),
                            (root.x, root.z + 1),
                        ] {
                            assert!((t.surface_y(x, z) - top).abs() < 3);
                        }
                        let ground =
                            t.generate_geology(root.x.div_euclid(16), root.z.div_euclid(16));
                        assert_eq!(
                            ground.get(
                                root.x.rem_euclid(16) as usize,
                                top,
                                root.z.rem_euclid(16) as usize
                            ),
                            biome.surface
                        );
                    }
                    for &(x, y, z, state) in &blocks {
                        assert!((x - root.x).abs() <= MAX_CROWN_RADIUS);
                        assert!((z - root.z).abs() <= MAX_CROWN_RADIUS);
                        assert!((MIN_Y..MIN_Y + HEIGHT).contains(&y));
                        crossed += usize::from(
                            (x.div_euclid(16), z.div_euclid(16))
                                != (root.x.div_euclid(16), root.z.div_euclid(16)),
                        );
                        logs += usize::from(state == blocks::OAK_LOG);
                    }
                    all_blocks.extend(blocks);
                }
            }
            for &(x, y, z, state) in all_blocks.iter().rev() {
                if let Some(chunk) = expected.get_mut(&(x.div_euclid(16), z.div_euclid(16))) {
                    let (lx, lz) = (x.rem_euclid(16) as usize, z.rem_euclid(16) as usize);
                    let old = chunk.get(lx, y, lz);
                    if old == blocks::AIR || (state == blocks::OAK_LOG && old == blocks::OAK_LEAVES)
                    {
                        chunk.set(lx, y, lz, state);
                    }
                }
            }
            let mut forward = Vec::new();
            for (&(cx, cz), reference) in &expected {
                let actual = t.generate(cx, cz);
                for y in MIN_Y..MIN_Y + HEIGHT {
                    for z in 0..16 {
                        for x in 0..16 {
                            assert_eq!(
                                actual.get(x, y, z),
                                reference.get(x, y, z),
                                "seed={seed}, chunk={cx},{cz}, block={x},{y},{z}"
                            );
                        }
                    }
                }
                forward.push(((cx, cz), actual));
            }
            for ((cx, cz), first) in forward.into_iter().rev() {
                assert_eq!(first, t.generate(cx, cz));
            }
        }
        assert!(crossed > 100 && logs > 100);
    }

    #[test]
    fn trees_near_entrances_have_intact_ground_in_either_chunk_order() {
        let t = TerrainGenerator::new(2026);
        let mut chunks = Vec::new();
        let (mut roots, mut holes) = (0, 0);
        // Include wooded origin chunks as well as the rocky entrance hillside.
        let probes = (8..=12)
            .flat_map(|cz| (-15..=-11).map(move |cx| (cx, cz)))
            .chain((-2..=2).flat_map(|cz| (-2..=2).map(move |cx| (cx, cz))));
        for (cx, cz) in probes {
            let chunk = t.generate(cx, cz);
            for z in 0..16 {
                for x in 0..16 {
                    let top = t.surface_y(cx * 16 + x as i32, cz * 16 + z as i32);
                    if chunk.get(x, top, z) == blocks::AIR {
                        holes += 1;
                        assert_ne!(chunk.get(x, top + 1, z), blocks::OAK_LOG);
                    }
                    if chunk.get(x, top + 1, z) == blocks::OAK_LOG {
                        roots += 1;
                        assert!(blocks::info(chunk.get(x, top, z)).solid);
                    }
                }
            }
            chunks.push(((cx, cz), chunk));
        }
        assert!(roots > 0 && holes > 0, "roots={roots}, holes={holes}");
        for ((cx, cz), chunk) in chunks.into_iter().rev() {
            assert_eq!(chunk, t.generate(cx, cz));
        }
    }

    fn sample_tree(shape: TreeShape, height: u8, variation: u64) -> Tree {
        Tree::new(
            Candidate {
                x: -1,
                z: 16,
                r: 0.0,
                variation: mix_stafford13(variation),
            },
            100,
            shape,
            [height, height],
        )
    }

    #[test]
    fn all_shapes_vary_and_respect_height_and_radius() {
        let (mut large, mut branched, mut wide_cone, mut narrow_cone) = (0, 0, 0, 0);
        for shape in [TreeShape::Round, TreeShape::Cone, TreeShape::Broad] {
            let mut counts = Vec::new();
            for variation in 0..128 {
                for height in 3..=12 {
                    let tree = sample_tree(shape, height, variation);
                    if tree.large {
                        large += 1;
                        assert!(
                            (i32::from(height) + 3..=i32::from(height) + 5).contains(&tree.height)
                        );
                    } else {
                        assert_eq!(tree.height, i32::from(height));
                    }
                    let mut trunk = Vec::new();
                    let mut branch_starts = 0;
                    let mut max_radius = 0;
                    let mut count = 0;
                    tree.blocks(|x, y, z, state| {
                        let (dx, dz) = ((x - tree.root.x).abs(), (z - tree.root.z).abs());
                        let radius = dx.max(dz);
                        max_radius = max_radius.max(radius);
                        assert!(radius <= MAX_CROWN_RADIUS);
                        assert!((101..=100 + tree.height + tree.tip).contains(&y));
                        if state == blocks::OAK_LOG {
                            assert!(y <= 100 + tree.height);
                            if radius == 0 {
                                trunk.push(y);
                            } else {
                                assert_eq!(shape, TreeShape::Round);
                                assert!(tree.height >= 7 || tree.large);
                                assert!(dx + dz <= 2);
                                branch_starts += usize::from(radius == 1);
                            }
                        }
                        count += 1;
                    });
                    assert_eq!(trunk, (101..=100 + tree.height).collect::<Vec<_>>());
                    if tree.large {
                        assert!((2..=3).contains(&branch_starts));
                    } else {
                        assert!(branch_starts <= 2);
                        branched += usize::from(branch_starts > 0);
                    }
                    if shape == TreeShape::Cone {
                        wide_cone += usize::from(max_radius == 3);
                        narrow_cone += usize::from((1..=2).contains(&max_radius));
                    }
                    counts.push(count);
                }
            }
            assert!(counts.windows(2).any(|w| w[0] != w[1]));
        }
        assert!(
            large > 0 && branched > 0 && wide_cone > 0 && narrow_cone > 0,
            "large={large}, branched={branched}, wide={wide_cone}, narrow={narrow_cone}"
        );
    }

    #[test]
    fn taller_trees_have_more_crown_leaves_on_average() {
        for shape in [TreeShape::Round, TreeShape::Cone] {
            let totals = [4, 9].map(|height| {
                (0..128)
                    .map(|variation| sample_tree(shape, height, variation))
                    .filter(|tree| !tree.large)
                    .map(|tree| {
                        let mut placed = BTreeMap::new();
                        tree.blocks(|x, y, z, state| {
                            if state == blocks::OAK_LOG {
                                placed.insert((x, y, z), state);
                            } else {
                                placed.entry((x, y, z)).or_insert(state);
                            }
                        });
                        placed
                            .values()
                            .filter(|&&state| state == blocks::OAK_LEAVES)
                            .count()
                    })
                    .sum::<usize>()
            });
            assert!(totals[1] > totals[0], "{shape:?}: {totals:?}");
        }
    }

    #[test]
    fn real_plots_have_large_and_branched_trees_and_repeat_exactly() {
        let terrain = TerrainGenerator::new(2026);
        let (mut large, mut branched) = (0, 0);
        for qz in -12..16 {
            for qx in -12..16 {
                let root = Candidate::new(2026, qx, qz);
                let emitted = terrain.tree_blocks(qx, qz);
                assert_eq!(emitted, terrain.tree_blocks(qx, qz));
                let max_height = BIOMES[terrain.biome_at(root.x, root.z) as usize].tree_height[1];
                let mut trunk = 0;
                let mut branch = false;
                for (x, _, z, state) in emitted {
                    if state == blocks::OAK_LOG {
                        if (x, z) == (root.x, root.z) {
                            trunk += 1;
                        } else {
                            branch = true;
                        }
                    }
                }
                large += usize::from(trunk > max_height);
                branched += usize::from(trunk <= max_height && branch);
            }
        }
        assert!(
            large > 0 && branched > 0,
            "large={large}, branched={branched}"
        );
    }

    #[test]
    fn biome_tree_rates_follow_registry_densities() {
        // Widely distributed real plots include all climates, water, slopes and
        // surface recipes. Normalize by plots per biome, not biome land area.
        let mut samples = [0usize; 13];
        let mut trees = [0usize; 13];
        for seed in [2026, 1, 777] {
            let t = TerrainGenerator::new(seed);
            for qz in (-2048..2048).step_by(16) {
                for qx in (-2048..2048).step_by(16) {
                    let root = Candidate::new(seed, qx, qz);
                    let id = t.biome_at(root.x, root.z) as usize;
                    samples[id] += 1;
                    trees[id] += usize::from(!t.tree_blocks(qx, qz).is_empty());
                }
            }
        }
        let rates: Vec<_> = trees
            .iter()
            .zip(samples)
            .map(|(&n, total)| n as f64 / total as f64)
            .collect();
        eprintln!("tree rates: {rates:?}; counts: {trees:?}");
        assert!(
            rates[2] > rates[5] && rates[5] > rates[0] && rates[0] > rates[3] && rates[3] > 0.0
        );
        for id in [1, 6, 7, 8, 9, 10, 11, 12] {
            assert!(samples[id] > 0);
            assert_eq!(trees[id], 0);
        }
    }
}
