//! Native build of the core. In M0 it serves two purposes: the reference
//! result for the cross-host determinism check, and a tick-time benchmark.
//!
//! Usage:
//!   native-server scenario <seed> <ticks>
//!   native-server noise [seed]
//!   native-server terrain [seed]
//!   native-server bench [players] [view] [ticks] [hills|terrain|flat]

use std::time::Instant;

use protocol::{C2S, PROTOCOL_VERSION};
use sim::Server;
use worldgen::Generator;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("scenario") => {
            let seed: i64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(2026);
            let ticks: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(600);
            let o = sim::scenario::run_detailed(seed, ticks);
            println!(
                "{{\"host\":\"native\",\"seed\":{seed},\"ticks\":{ticks},\"hash\":\"{:016x}\",\"blocksChanged\":{},\"chunksSaved\":{},\"chunksReloaded\":{}}}",
                o.hash, o.blocks_changed, o.chunks_saved, o.chunks_reloaded
            );
        }
        Some("terrain") => {
            let seed = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(2026);
            println!("{:016x}", worldgen::terrain_fingerprint(seed));
        }
        Some("noise") => {
            let seed = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(2026);
            println!("{:016x}", noise::fingerprint(seed));
        }
        Some("bench") => {
            let players: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(8);
            let view: u8 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(8);
            let ticks: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1200);
            let generator = match args.get(4).map(String::as_str) {
                Some("terrain") => Generator::Terrain,
                Some("flat") => Generator::Flat,
                _ => Generator::DebugHills,
            };
            bench(players, view, ticks, generator);
        }
        _ => {
            eprintln!(
                "usage: native-server scenario <seed> <ticks> | noise [seed] | terrain [seed] | bench [players] [view] [ticks] [hills|terrain|flat]"
            );
            std::process::exit(2);
        }
    }
}

/// Scripted, host-authorized teleports advance spread-out players at 0.28
/// blocks/tick to measure chunk generation/streaming regardless of terrain.
/// Chunks are generated, sent and unloaded throughout the run.
fn bench(players: u32, view: u8, ticks: u32, generator: Generator) {
    let mut server = Server::new(2026, generator);
    server.set_entity_persistence(false);
    let flight_y = if generator == Generator::Terrain {
        240.0
    } else {
        80.0
    };
    for id in 1..=players {
        server.connect_at(
            id,
            true,
            Some([id as f64 * 400.0, flight_y, id as f64 * -250.0]),
            None,
        );
        server.handle_packet(
            id,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: view,
            }
            .encode(),
        );
    }
    let mut times = Vec::with_capacity(ticks as usize);
    let mut bytes_out = 0usize;
    for t in 0..ticks {
        for id in 1..=players {
            let x = id as f64 * 400.0 + t as f64 * 0.28;
            let z = id as f64 * -250.0;
            server.handle_packet(id, &C2S::Teleport { x, y: flight_y, z }.encode());
        }
        let start = Instant::now();
        server.tick();
        let out = server.take_outbox();
        times.push(start.elapsed().as_secs_f64() * 1000.0);
        bytes_out += out.iter().map(|(_, b)| b.len()).sum::<usize>();
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let pct = |p: f64| times[((times.len() - 1) as f64 * p) as usize];
    println!(
        "{{\"host\":\"native\",\"players\":{players},\"view\":{view},\"ticks\":{ticks},\"msptMean\":{mean:.3},\"msptP50\":{:.3},\"msptP99\":{:.3},\"msptMax\":{:.3},\"loadedChunks\":{},\"chunksGenerated\":{},\"mbSent\":{:.1},\"positions_rejected\":{}}}",
        pct(0.5),
        pct(0.99),
        pct(1.0),
        server.loaded_chunks(),
        server.stats.chunks_generated,
        bytes_out as f64 / 1e6,
        server.stats.positions_rejected
    );
    assert_eq!(
        server.stats.positions_rejected, 0,
        "benchmark movement was rejected"
    );
}
