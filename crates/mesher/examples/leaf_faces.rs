use mesher::{mesh_section_layers, padded_index, PADDED_LEN, WORDS_PER_QUAD};
use world::{biomes::BIOMES, blocks, World, MIN_Y, SECTIONS};
use worldgen::TerrainGenerator;

const SEED: i64 = 2026;
const WIDTH: i32 = 9;
const SEARCH_RADIUS: i32 = 16;
const BYTES_PER_QUAD: usize = WORDS_PER_QUAD * size_of::<u32>();

fn main() {
    let terrain = TerrainGenerator::new(SEED);
    let rain_grove = BIOMES.iter().position(|b| b.name == "rain_grove").unwrap();
    let mut grove_cells = std::collections::BTreeMap::new();
    for cz in -SEARCH_RADIUS..=SEARCH_RADIUS {
        for cx in -SEARCH_RADIUS..=SEARCH_RADIUS {
            let count = terrain
                .biome_cells(cx, cz)
                .iter()
                .filter(|&&id| usize::from(id) == rain_grove)
                .count();
            grove_cells.insert((cx, cz), count);
        }
    }
    let mut best = (0, 0, 0);
    for cz in -SEARCH_RADIUS..=SEARCH_RADIUS - WIDTH + 1 {
        for cx in -SEARCH_RADIUS..=SEARCH_RADIUS - WIDTH + 1 {
            let count: usize = (cz..cz + WIDTH)
                .flat_map(|z| (cx..cx + WIDTH).map(move |x| (x, z)))
                .map(|coord| grove_cells[&coord])
                .sum();
            if count > best.2 {
                best = (cx, cz, count);
            }
        }
    }
    let (cx, cz, grove_count) = best;
    assert!(grove_count > 0);
    let mut world = World::new();
    for z in cz..cz + WIDTH {
        for x in cx..cx + WIDTH {
            world.insert_chunk_unlit(terrain.generate(x, z));
        }
    }
    println!(
        "seed={SEED}, cx={cx}..={}, cz={cz}..={}, rain_grove={grove_count}/{} biome cells",
        cx + WIDTH - 1,
        cz + WIDTH - 1,
        WIDTH * WIDTH * 16
    );

    let regular = u32::from(blocks::info(blocks::OAK_LEAVES).tex[0]);
    let dense = blocks::TEXTURES
        .iter()
        .position(|&name| name == "oak_leaves_dense")
        .map(|id| id as u32);
    let mut padded = vec![blocks::AIR; PADDED_LEN];
    let mut vertices = Vec::new();
    let mut layers = [0; 3];
    let (mut leaves, mut pairs, mut leaf_faces, mut dense_faces) = (0, 0, 0, 0);
    for (&(cx, cz), chunk) in &world.chunks {
        for sy in 0..SECTIONS {
            if chunk.sections[sy].is_empty() {
                continue;
            }
            let base_y = MIN_Y + sy as i32 * 16;
            for y in -1..=16 {
                for z in -1..=16 {
                    for x in -1..=16 {
                        // Match the client's stone padding for unloaded columns.
                        padded[padded_index(x, y, z)] = world
                            .get_block(cx * 16 + x, base_y + y, cz * 16 + z)
                            .unwrap_or(if world::section_index(base_y + y).is_some() {
                                blocks::STONE
                            } else {
                                blocks::AIR
                            });
                    }
                }
            }
            for y in 0..16 {
                for z in 0..16 {
                    for x in 0..16 {
                        if blocks::is_oak_leaves(padded[padded_index(x, y, z)]) {
                            leaves += 1;
                            // Count each interface once, including across sections.
                            pairs += [(x + 1, y, z), (x, y + 1, z), (x, y, z + 1)]
                                .into_iter()
                                .filter(|&(x, y, z)| {
                                    blocks::is_oak_leaves(padded[padded_index(x, y, z)])
                                })
                                .count();
                        }
                    }
                }
            }
            vertices.clear();
            let counts = mesh_section_layers(&padded, None, &mut vertices);
            for (total, count) in layers.iter_mut().zip(counts) {
                *total += count as usize;
            }
            assert_eq!(
                vertices.len(),
                counts.iter().sum::<u32>() as usize * WORDS_PER_QUAD
            );
            for quad in vertices.as_chunks::<WORDS_PER_QUAD>().0 {
                let texture = quad[1] & 4095;
                let is_dense = Some(texture) == dense;
                leaf_faces += usize::from(texture == regular || is_dense);
                dense_faces += usize::from(is_dense);
            }
        }
    }

    let total: usize = layers.iter().sum();
    for (name, count) in ["opaque", "cutout", "translucent", "total"]
        .into_iter()
        .zip(layers.into_iter().chain([total]))
    {
        println!(
            "{name}: {count} faces, {} vertex bytes",
            count * BYTES_PER_QUAD
        );
    }
    let internal_faces = pairs * 2;
    let with_internal = total + internal_faces;
    println!("leaf blocks={leaves}, touching pairs={pairs}, extra internal faces={internal_faces}");
    println!(
        "with internal faces: {with_internal} faces, {} vertex bytes",
        with_internal * BYTES_PER_QUAD
    );
    println!(
        "dense leaf faces={dense_faces}/{leaf_faces} ({:.2}%)",
        100.0 * dense_faces as f64 / leaf_faces as f64
    );
}
