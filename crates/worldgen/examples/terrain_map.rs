//! Original biome colours, shaded by unchanged terrain height; binary PPM.
use std::{
    fs::File,
    io::{BufWriter, Write},
};
use world::biomes::BIOMES;
use worldgen::TerrainGenerator;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err("usage: terrain_map <seed> <blocks_per_pixel> <out.ppm>".into());
    }
    let seed: i64 = args[1].parse()?;
    let step: i32 = args[2].parse()?;
    if !(1..=4096).contains(&step) {
        return Err("blocks_per_pixel must be 1..=4096".into());
    }
    let terrain = TerrainGenerator::new(seed);
    let mut out = BufWriter::new(File::create(&args[3])?);
    writeln!(out, "P6\n1024 512\n255")?;
    // Left: biome colours with height shading. Right: grayscale height.
    let colours: [[u8; 3]; 13] = [
        [115, 185, 91],
        [230, 198, 113],
        [39, 119, 70],
        [177, 151, 77],
        [225, 239, 246],
        [61, 137, 126],
        [41, 92, 167],
        [144, 195, 219],
        [66, 172, 193],
        [239, 216, 161],
        [136, 127, 140],
        [123, 104, 93],
        [194, 204, 235],
    ];
    for iz in -256..256 {
        let mut row = Vec::with_capacity(1024 * 3);
        let mut heights = Vec::with_capacity(512 * 3);
        for ix in -256..256 {
            let (x, z) = (ix * step, iz * step);
            let y = terrain.surface_y(x, z);
            let id = terrain.biome_at(x, z) as usize;
            let colour = colours.get(id).ok_or("missing biome map colour")?;
            let shade = 0.65 + y as f64 / 440.0;
            row.extend(colour.map(|c| (c as f64 * shade).min(255.0) as u8));
            heights.extend([((y + 64) * 255 / 384) as u8; 3]);
        }
        row.extend(heights);
        out.write_all(&row)?;
    }
    out.flush()?;
    for (b, c) in BIOMES.iter().zip(colours) {
        eprintln!("{}: #{:02x}{:02x}{:02x}", b.name, c[0], c[1], c[2]);
    }
    Ok(())
}
