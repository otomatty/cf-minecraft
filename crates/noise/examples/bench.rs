use noise::{Fbm, GradientNoise};
use std::{hint::black_box, time::Instant};

fn main() {
    let fbm = Fbm::new(2026, 5, 1.9, 0.55);
    let noise = GradientNoise::new(2026);
    // Repeat 2D enough times for a useful clock resolution; report per chunk.
    let start = Instant::now();
    for _ in 0..1000 {
        for z in 0..16 {
            for x in 0..16 {
                black_box(fbm.sample2(black_box(x as f64 / 64.0), z as f64 / 64.0));
            }
        }
    }
    println!(
        "2D fBm (5 octaves), 256 points: {:?}/chunk",
        start.elapsed() / 1000
    );
    let start = Instant::now();
    for y in 0..384 {
        for z in 0..16 {
            for x in 0..16 {
                black_box(noise.sample3(
                    black_box(x as f64 / 64.0),
                    y as f64 / 64.0,
                    z as f64 / 64.0,
                ));
            }
        }
    }
    println!("3D gradient, 16×384×16 points: {:?}/chunk", start.elapsed());
}
