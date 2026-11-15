//! Reproduce initial-light timings without timing terrain generation or cloning.
use std::time::{Duration, Instant};
use world::World;
use worldgen::{generate, Generator};

fn main() {
    let chunks: Vec<_> = (-12..=12)
        .flat_map(|z| (-12..=12).map(move |x| generate(Generator::DebugHills, 2026, x, z)))
        .collect();
    let mut direct = World::with_lighting(true);
    let mut total = Duration::ZERO;
    let mut maximum = Duration::ZERO;
    for chunk in chunks.iter().cloned() {
        let start = Instant::now();
        direct.insert_chunk(chunk);
        let elapsed = start.elapsed();
        total += elapsed;
        maximum = maximum.max(elapsed);
    }
    println!("insert_chunk: total={total:?}, max={maximum:?}");
    let direct_total = total;
    let mut deferred = World::with_lighting(true);
    let start = Instant::now();
    for chunk in chunks {
        deferred.insert_chunk_unlit(chunk);
    }
    total = start.elapsed();
    let mut keys: Vec<_> = deferred.chunks.keys().copied().collect();
    keys.sort_by_key(|&(x, z)| {
        (
            (x * 16 + 8) * (x * 16 + 8) + (z * 16 + 8) * (z * 16 + 8),
            x,
            z,
        )
    });
    maximum = Duration::ZERO;
    for (x, z) in keys {
        let start = Instant::now();
        deferred.light_chunk(x, z);
        let elapsed = start.elapsed();
        total += elapsed;
        maximum = maximum.max(elapsed);
    }
    println!(
        "deferred: total={total:?}, max={maximum:?}, ratio={:.3}",
        total.as_secs_f64() / direct_total.as_secs_f64()
    );
    for (key, chunk) in &direct.chunks {
        // Compare logical values; uniform/packed representation is immaterial.
        for s in 0..world::SECTIONS {
            for i in 0..4096 {
                let a = &chunk.lighting.as_ref().unwrap().sections[s];
                let b = &deferred.chunks[key].lighting.as_ref().unwrap().sections[s];
                assert_eq!(
                    (a.sky.get(i), a.block.get(i)),
                    (b.sky.get(i), b.block.get(i))
                );
            }
        }
    }
}
