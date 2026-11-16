//! World-aligned feature plots. A tree is a pure description; chunks only clip it.
use jmath::mix_stafford13;
use world::{
    biomes::{TreeShape, BIOMES},
    blocks, BlockState, Chunk, HEIGHT, MIN_Y,
};

use crate::{TerrainGenerator, SEA_LEVEL};

pub(crate) const PLOT_SIZE: i32 = 4;
pub(crate) const MAX_CROWN_RADIUS: i32 = 3;
const _: () = assert!(MAX_CROWN_RADIUS <= 3 && MAX_CROWN_RADIUS < PLOT_SIZE);
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
}
impl Tree {
    fn blocks(&self, mut emit: impl FnMut(i32, i32, i32, BlockState)) {
        let mut put = |dx: i32, y, dz: i32, state| {
            debug_assert!(dx.abs() <= MAX_CROWN_RADIUS && dz.abs() <= MAX_CROWN_RADIUS);
            emit(self.root.x + dx, y, self.root.z + dz, state);
        };
        let crown = self.top + self.height;
        for y in self.top + 1..=crown {
            put(0, y, 0, blocks::OAK_LOG);
        }
        let mut layer = |y: i32, radius: i32, cross: bool| {
            for dz in -radius..=radius {
                for dx in -radius..=radius {
                    let corner = dx.abs() == radius && dz.abs() == radius;
                    // The four round crown corners vary independently per layer.
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
        match self.shape {
            TreeShape::Round => {
                layer(crown - 2, 2, false);
                layer(crown - 1, 2, false);
                layer(crown, 1, false);
                layer(crown + 1, 1, true);
            }
            TreeShape::Cone => {
                let start = self.top + 1 + self.height / 2;
                for y in start..=crown {
                    let remaining = crown - y;
                    let radius = (2 - (y - start) % 3).min((remaining + 1) / 2);
                    // Alternate full and cross tiers as the cone narrows upward.
                    layer(y, radius, (y & 1) == (self.root.variation & 1) as i32);
                }
                for dy in 1..=self.tip {
                    layer(crown + dy, 0, false);
                }
            }
            TreeShape::None => unreachable!(),
        }
    }
}

impl TerrainGenerator {
    fn tree(&self, root: Candidate, height_at: impl Fn(i32, i32) -> i32) -> Option<Tree> {
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
        let [min, max] = b.tree_height;
        let height = i32::from(min) + (root.variation % u64::from(max - min + 1)) as i32;
        let tip = if b.tree_shape == TreeShape::Cone {
            1 + ((root.variation >> 8) & 1) as i32
        } else {
            1
        };
        (top + height + tip < MIN_Y + HEIGHT).then_some(Tree {
            root,
            top,
            height,
            shape: b.tree_shape,
            tip,
        })
    }

    pub(crate) fn plant_trees(
        &self,
        chunk: &mut Chunk,
        cx: i32,
        cz: i32,
        height_at: impl Fn(i32, i32) -> i32,
    ) {
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
                if let Some(tree) = self.tree(root, |x, z| height_at(x - cx * 16, z - cz * 16)) {
                    tree.blocks(|x, y, z, state| {
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
        if let Some(tree) = self.tree(Candidate::new(self.seed, qx, qz), |x, z| {
            self.surface_y(x, z)
        }) {
            tree.blocks(|x, y, z, state| result.push((x, y, z, state)));
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

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
    fn both_shapes_vary_and_respect_height_and_radius() {
        for shape in [TreeShape::Round, TreeShape::Cone] {
            let mut counts = Vec::new();
            for variation in 0..64 {
                for height in 3..=12 {
                    let tree = Tree {
                        root: Candidate {
                            x: -1,
                            z: 16,
                            r: 0.0,
                            variation,
                        },
                        top: 100,
                        height,
                        shape,
                        tip: 1 + (variation & 1) as i32,
                    };
                    let mut count = 0;
                    tree.blocks(|x, y, z, state| {
                        assert!(
                            (x + 1).abs() <= MAX_CROWN_RADIUS && (z - 16).abs() <= MAX_CROWN_RADIUS
                        );
                        if state == blocks::OAK_LOG {
                            assert_eq!((x, z), (-1, 16));
                            assert!((101..=100 + height).contains(&y));
                        }
                        count += 1;
                    });
                    counts.push(count);
                }
            }
            assert!(counts.windows(2).any(|w| w[0] != w[1]));
        }
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
