//! Original biome colours, shaded by unchanged terrain height; binary PPM.
use std::{
    fs::File,
    io::{BufWriter, Write},
};
use world::{biomes::BIOMES, blocks};
use worldgen::TerrainGenerator;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(2).is_some_and(|arg| arg == "--entrances") {
        if !(4..=5).contains(&args.len()) {
            return Err("usage: terrain_map <seed> --entrances <radius_blocks> [count=10]".into());
        }
        let seed = args[1].parse()?;
        let radius: i32 = args[3].parse()?;
        let count: usize = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(10);
        if !(1..=2048).contains(&radius) {
            return Err("radius_blocks must be 1..=2048".into());
        }
        measure_entrances(seed, radius, count);
        return Ok(());
    }
    if args.len() != 4 {
        return Err("usage: terrain_map <seed> <blocks_per_pixel> <out.ppm> | <seed> --entrances <radius_blocks> [count]".into());
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

/// Flood only underground air; a 512-block halo connects mouths near the survey edge.
fn measure_entrances(seed: i64, radius: i32, count: usize) {
    use world::{HEIGHT, MIN_Y};
    let terrain = TerrainGenerator::new(seed);
    let low = -radius - 512;
    let high = radius + 512; // Exclusive: --entrances 400 surveys exactly 800 x 800 columns.
    let width = (high - low) as usize;
    let mut tops = vec![MIN_Y; width * width];
    let mut air = vec![0u64; width * width * HEIGHT as usize / 64];
    let index = |x: i32, y: i32, z: i32| {
        (((z - low) as usize * width + (x - low) as usize) * HEIGHT as usize) + (y - MIN_Y) as usize
    };
    let mut mouths = Vec::new();
    for cz in low.div_euclid(16)..=(high - 1).div_euclid(16) {
        for cx in low.div_euclid(16)..=(high - 1).div_euclid(16) {
            let chunk = terrain.generate(cx, cz);
            for z in 0..16 {
                for x in 0..16 {
                    let (wx, wz) = (cx * 16 + x as i32, cz * 16 + z as i32);
                    if wx < low || wx >= high || wz < low || wz >= high {
                        continue;
                    }
                    let top = terrain.surface_y(wx, wz);
                    tops[(wz - low) as usize * width + (wx - low) as usize] = top;
                    for y in MIN_Y..=top {
                        if chunk.get(x, y, z) == blocks::AIR {
                            let i = index(wx, y, wz);
                            air[i / 64] |= 1 << (i % 64);
                        }
                    }
                    if top > worldgen::SEA_LEVEL + 2
                        && chunk.get(x, top, z) == blocks::AIR
                        && (-radius..radius).contains(&wx)
                        && (-radius..radius).contains(&wz)
                    {
                        mouths.push(index(wx, top, wz));
                    }
                }
            }
        }
    }
    let mouth_columns = mouths.len();
    let mut components = Vec::new();
    let mut clipped = 0;
    for start in mouths {
        if air[start / 64] & (1 << (start % 64)) == 0 {
            continue;
        }
        let mut queue = vec![start];
        air[start / 64] &= !(1 << (start % 64));
        let mut cursor = 0;
        let mut min_y = i32::MAX;
        let mut max_top = MIN_Y;
        let mut closest = (i64::MAX, 0, 0, 0);
        let mut edge = false;
        while cursor < queue.len() {
            let i = queue[cursor];
            cursor += 1;
            let col = i / HEIGHT as usize;
            let y = MIN_Y + (i % HEIGHT as usize) as i32;
            let x = low + (col % width) as i32;
            let z = low + (col / width) as i32;
            min_y = min_y.min(y);
            edge |= x == low || x == high - 1 || z == low || z == high - 1;
            if y == tops[col]
                && y > worldgen::SEA_LEVEL + 2
                && (-radius..radius).contains(&x)
                && (-radius..radius).contains(&z)
            {
                max_top = max_top.max(y);
                closest = closest.min((i64::from(x).pow(2) + i64::from(z).pow(2), x, y, z));
            }
            for (nx, ny, nz) in [
                (x - 1, y, z),
                (x + 1, y, z),
                (x, y - 1, z),
                (x, y + 1, z),
                (x, y, z - 1),
                (x, y, z + 1),
            ] {
                if nx < low
                    || nx >= high
                    || nz < low
                    || nz >= high
                    || !(MIN_Y..MIN_Y + HEIGHT).contains(&ny)
                {
                    continue;
                }
                let next = index(nx, ny, nz);
                if air[next / 64] & (1 << (next % 64)) != 0 {
                    air[next / 64] &= !(1 << (next % 64));
                    queue.push(next);
                }
            }
        }
        if edge {
            println!(
                "boundary continuation: nearest=({}, {}, {}), min_y={min_y}",
                closest.1, closest.2, closest.3
            );
        }
        clipped += usize::from(edge);
        components.push((closest, max_top - min_y, min_y));
    }
    components.sort_unstable();
    let mut bins = [0usize; 6];
    for &(_, depth, _) in &components {
        bins[match depth {
            0..=2 => 0,
            3..=5 => 1,
            6..=9 => 2,
            10..=23 => 3,
            24..=39 => 4,
            _ => 5,
        }] += 1;
    }
    println!("seed={seed}, x/z=-{radius}..{radius} (exclusive), halo=512, mouth_columns={mouth_columns}, holes={}, deep_entrances={}, clipped_components={clipped}", components.len(), bins[3..].iter().sum::<usize>());
    println!("depth bins [0..2, 3..5, 6..9, 10..23, 24..39, 40+]: {bins:?}");
    for ((distance, x, y, z), depth, min_y) in components.into_iter().take(count) {
        let distance = distance_milliblocks(distance);
        println!(
            "({x}, {y}, {z}) distance={}.{:03} depth={depth} min_y={min_y}",
            distance / 1000,
            distance % 1000
        );
    }
}

fn distance_milliblocks(distance_squared: i64) -> u64 {
    let scaled = distance_squared as u64 * 1_000_000;
    let lower = scaled.isqrt();
    // Round sqrt(scaled) at lower + 0.5. With integer scaled, a tie is impossible.
    lower + u64::from(scaled - lower * lower > lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_distance_preserves_three_decimal_display() {
        for squared in (0..100_000).chain(8_380_000..=8_388_608) {
            let distance = distance_milliblocks(squared);
            assert_eq!(
                format!("{}.{:03}", distance / 1000, distance % 1000),
                format!("{:.3}", (squared as f64).sqrt()),
                "distance_squared={squared}"
            );
        }
    }
}
