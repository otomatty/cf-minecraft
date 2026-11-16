use std::{hint::black_box, time::Instant};
use worldgen::{generate, Generator, TerrainGenerator};

fn main() {
    let terrain = TerrainGenerator::new(2026);
    for name in ["Terrain", "DebugHills"] {
        let mut total = 0.0f64;
        let mut max = 0.0f64;
        for cz in -12..=12 {
            for cx in -12..=12 {
                let start = Instant::now();
                black_box(if name == "Terrain" {
                    terrain.generate(cx, cz)
                } else {
                    generate(Generator::DebugHills, 2026, cx, cz)
                });
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                total += ms;
                max = max.max(ms);
            }
        }
        println!("{name}: mean={:.3} ms/chunk max={max:.3} ms/chunk (625 chunks, seed=2026; initialization excluded)", total / 625.0);
    }
    let mut total = 0.0f64;
    let mut max = 0.0f64;
    for cz in -12..=12 {
        for cx in -12..=12 {
            let start = Instant::now();
            black_box(terrain.biome_cells(black_box(cx), black_box(cz)));
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            total += ms;
            max = max.max(ms);
        }
    }
    println!("biome_cells: mean={:.3} ms/chunk max={max:.3} ms/chunk (625 chunks, seed=2026; initialization excluded)", total / 625.0);
}
