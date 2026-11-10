//! A scripted play session used to prove that every host computes the same
//! world: join, walk, edit blocks, save, wander off, have chunks reloaded.
//!
//! The result folds together the final world state and every byte the server
//! sent, so any divergence in logic, ordering or serialization changes it.

use std::collections::BTreeMap;

use jmath::JavaRandom;
use protocol::{C2S, PROTOCOL_VERSION};
use world::{blocks, Fnv64};
use worldgen::Generator;

use crate::Server;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub hash: u64,
    pub blocks_changed: u64,
    pub chunks_reloaded: u64,
    pub chunks_saved: u64,
}

pub fn run(seed: i64, ticks: u32) -> u64 {
    run_detailed(seed, ticks).hash
}

pub fn run_detailed(seed: i64, ticks: u32) -> Outcome {
    let mut server = Server::new(seed, Generator::DebugHills);
    let mut rng = JavaRandom::new(seed ^ 0x5EED);
    let mut disk: BTreeMap<(i32, i32), Vec<u8>> = BTreeMap::new();
    let mut wire = Fnv64::new();

    server.connect(1);
    server.handle_packet(
        1,
        &C2S::Hello {
            protocol: PROTOCOL_VERSION,
            view_distance: 4,
        }
        .encode(),
    );

    let [mut x, _, mut z] = server.spawn();
    let y = 70.0;
    for t in 0..ticks {
        // Out for the first half, back for the second, so saved chunks get reloaded.
        let direction = if t < ticks / 2 { 1.0 } else { -1.0 };
        x += direction * 0.9 + (rng.next_double() - 0.5);
        z += rng.next_double() - 0.5;
        server.handle_packet(
            1,
            &C2S::PlayerPos {
                x,
                y,
                z,
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode(),
        );

        for _ in 0..4 {
            let bx = x.floor() as i32 + rng.next_int_bound(9) - 4;
            let by = 64 + rng.next_int_bound(12);
            let bz = z.floor() as i32 + rng.next_int_bound(9) - 4;
            let state = rng.next_int_bound(blocks::COUNT as i32) as u16;
            server.handle_packet(
                1,
                &C2S::SetBlock {
                    x: bx,
                    y: by,
                    z: bz,
                    state,
                }
                .encode(),
            );
        }

        server.tick();

        for (client, bytes) in server.take_outbox() {
            wire.i32(client as i32);
            wire.bytes(&bytes);
        }
        for (cx, cz) in server.take_requests() {
            match disk.get(&(cx, cz)) {
                Some(bytes) => {
                    server.load_chunk(cx, cz, bytes);
                }
                None => server.chunk_missing(cx, cz),
            }
        }
        if t % 40 == 39 {
            while let Some((cx, cz, bytes)) = server.take_dirty() {
                disk.insert((cx, cz), bytes);
            }
        }
    }

    let mut h = Fnv64::new();
    h.i64(server.state_hash() as i64);
    h.i64(wire.finish() as i64);
    h.i64(server.stats.blocks_changed as i64);
    h.i64(server.stats.chunks_loaded_from_storage as i64);
    Outcome {
        hash: h.finish(),
        blocks_changed: server.stats.blocks_changed,
        chunks_reloaded: server.stats.chunks_loaded_from_storage,
        chunks_saved: disk.len() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenario_is_repeatable_and_seed_sensitive() {
        let a = run(2026, 300);
        assert_eq!(a, run(2026, 300));
        assert_ne!(a, run(2027, 300));
        assert_ne!(a, run(2026, 301));
    }

    #[test]
    fn scenario_really_edits_saves_and_reloads() {
        let o = run_detailed(5, 600);
        assert!(
            o.blocks_changed > 500,
            "only {} edits applied",
            o.blocks_changed
        );
        assert!(o.chunks_saved > 10, "only {} chunks saved", o.chunks_saved);
        assert!(
            o.chunks_reloaded > 5,
            "only {} chunks reloaded",
            o.chunks_reloaded
        );
    }
}
