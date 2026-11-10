//! The authoritative game simulation ("the server").
//!
//! Sans-IO: this crate never touches a socket, a clock, a file or a thread.
//! A host (browser worker, Durable Object, native process) drives it:
//!
//! ```text
//! host                               core
//!  | -- handle_packet(client, bytes) -> |   queued, applied on the next tick
//!  | -- tick() -----------------------> |   exactly 1/20 s of game time
//!  | <- take_outbox() ----------------- |   packets to deliver
//!  | <- take_requests() --------------- |   chunks the core wants from storage
//!  | -- load_chunk(cx, cz, bytes) ----> |
//!  | <- take_dirty() ------------------ |   chunks to persist
//! ```
//!
//! Given the same seed and the same sequence of calls, every host ends up in
//! the same state. `state_hash` makes that checkable.

pub mod scenario;

use std::collections::{BTreeMap, BTreeSet};

use protocol::{C2S, S2C};
use world::io::Reader;
use world::{blocks, Chunk, Fnv64, World, HEIGHT, MIN_Y};
use worldgen::Generator;

pub const TICKS_PER_SECOND: u32 = 20;
/// The game sends the time to clients once per second.
const TIME_UPDATE_INTERVAL: i64 = 20;
/// New chunks sent per tick: a cap per client, and one across all clients
/// that bounds the time a tick can spend generating terrain.
const CHUNK_SENDS_PER_CLIENT: usize = 6;
const CHUNK_SENDS_PER_TICK: usize = 24;
const MAX_VIEW_DISTANCE: i32 = 12;
const DEFAULT_VIEW_DISTANCE: i32 = 6;
/// Chunks further than view distance + this margin from every player are dropped.
const UNLOAD_MARGIN: i32 = 2;
const UNLOAD_INTERVAL: i64 = 100;
/// Generous interaction range; real reach rules arrive with survival mode.
const MAX_REACH: f64 = 8.0;

type ChunkPos = (i32, i32);

struct Client {
    joined: bool,
    view: i32,
    pos: [f64; 3],
    sent: BTreeSet<ChunkPos>,
}

impl Client {
    fn center(&self) -> ChunkPos {
        (
            (self.pos[0].floor() as i32) >> 4,
            (self.pos[2].floor() as i32) >> 4,
        )
    }

    fn in_view(&self, c: ChunkPos) -> bool {
        let (cx, cz) = self.center();
        (c.0 - cx).abs() <= self.view && (c.1 - cz).abs() <= self.view
    }
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stats {
    pub packets_rejected: u64,
    pub blocks_changed: u64,
    pub chunks_generated: u64,
    pub chunks_loaded_from_storage: u64,
}

pub struct Server {
    seed: i64,
    generator: Generator,
    game_time: i64,
    day_time: i64,
    world: World,
    clients: BTreeMap<u32, Client>,
    pending: Vec<(u32, C2S)>,
    outbox: Vec<(u32, Vec<u8>)>,
    /// Chunks the host has in storage.
    stored: BTreeSet<ChunkPos>,
    /// Asked from the host, not yet delivered.
    requested: BTreeSet<ChunkPos>,
    requests: Vec<ChunkPos>,
    pub stats: Stats,
}

impl Server {
    pub fn new(seed: i64, generator: Generator) -> Self {
        Self {
            seed,
            generator,
            game_time: 0,
            day_time: 0,
            world: World::new(),
            clients: BTreeMap::new(),
            pending: Vec::new(),
            outbox: Vec::new(),
            stored: BTreeSet::new(),
            requested: BTreeSet::new(),
            requests: Vec::new(),
            stats: Stats::default(),
        }
    }

    pub fn seed(&self) -> i64 {
        self.seed
    }

    pub fn game_time(&self) -> i64 {
        self.game_time
    }

    /// Restores the clock after a restart.
    pub fn set_time(&mut self, game_time: i64, day_time: i64) {
        self.game_time = game_time;
        self.day_time = day_time;
    }

    pub fn day_time(&self) -> i64 {
        self.day_time
    }

    pub fn loaded_chunks(&self) -> usize {
        self.world.chunks.len()
    }

    pub fn client_count(&self) -> usize {
        self.clients.len()
    }

    pub fn spawn(&self) -> [f64; 3] {
        let y = worldgen::surface_y(self.generator, self.seed, 0, 0) + 1;
        [0.5, y as f64, 0.5]
    }

    pub fn connect(&mut self, id: u32) {
        let pos = self.spawn();
        self.clients.insert(
            id,
            Client {
                joined: false,
                view: DEFAULT_VIEW_DISTANCE,
                pos,
                sent: BTreeSet::new(),
            },
        );
    }

    pub fn disconnect(&mut self, id: u32) {
        self.clients.remove(&id);
        self.pending.retain(|(c, _)| *c != id);
        self.outbox.retain(|(c, _)| *c != id);
    }

    /// Queues a packet. It takes effect at the start of the next tick, in
    /// arrival order, like the game's main-thread packet handling.
    pub fn handle_packet(&mut self, id: u32, bytes: &[u8]) {
        if !self.clients.contains_key(&id) {
            return;
        }
        match C2S::decode(bytes) {
            Ok(p) => self.pending.push((id, p)),
            Err(_) => self.stats.packets_rejected += 1,
        }
    }

    pub fn tick(&mut self) {
        let pending = std::mem::take(&mut self.pending);
        for (id, packet) in pending {
            self.apply(id, packet);
        }
        self.stream_chunks();

        self.game_time += 1;
        self.day_time += 1;
        if self.game_time % TIME_UPDATE_INTERVAL == 0 {
            let bytes = S2C::TimeUpdate {
                game_time: self.game_time,
                day_time: self.day_time,
            }
            .encode();
            let ids: Vec<u32> = self
                .clients
                .iter()
                .filter(|(_, c)| c.joined)
                .map(|(id, _)| *id)
                .collect();
            for id in ids {
                self.outbox.push((id, bytes.clone()));
            }
        }
        if self.game_time % UNLOAD_INTERVAL == 0 {
            self.unload_far_chunks();
        }
    }

    fn apply(&mut self, id: u32, packet: C2S) {
        match packet {
            C2S::Hello {
                protocol,
                view_distance,
            } => {
                if protocol != protocol::PROTOCOL_VERSION {
                    self.stats.packets_rejected += 1;
                    return;
                }
                let spawn = self.spawn();
                let Some(client) = self.clients.get_mut(&id) else {
                    return;
                };
                if client.joined {
                    return;
                }
                client.joined = true;
                client.view = (view_distance as i32).clamp(2, MAX_VIEW_DISTANCE);
                let welcome = S2C::Welcome {
                    seed: self.seed,
                    game_time: self.game_time,
                    spawn,
                    view_distance: client.view as u8,
                };
                self.outbox.push((id, welcome.encode()));
            }
            C2S::PlayerPos { x, y, z, .. } => {
                let Some(client) = self.clients.get_mut(&id) else {
                    return;
                };
                // World border of the game: +-29,999,984 blocks.
                let ok = [x, y, z].iter().all(|v| v.is_finite())
                    && x.abs() < 2.9999984e7
                    && z.abs() < 2.9999984e7;
                if client.joined && ok {
                    client.pos = [x, y, z];
                } else {
                    self.stats.packets_rejected += 1;
                }
            }
            C2S::SetBlock { x, y, z, state } => {
                if !self.can_edit(id, x, y, z, state) {
                    self.stats.packets_rejected += 1;
                    return;
                }
                if let Some(old) = self.world.set_block(x, y, z, state) {
                    if old != state {
                        self.stats.blocks_changed += 1;
                        self.broadcast_block(x, y, z, state);
                    }
                }
            }
        }
    }

    fn can_edit(&self, id: u32, x: i32, y: i32, z: i32, state: u16) -> bool {
        let Some(client) = self.clients.get(&id) else {
            return false;
        };
        if !client.joined || !blocks::is_valid(state) || !(MIN_Y..MIN_Y + HEIGHT).contains(&y) {
            return false;
        }
        if !client.sent.contains(&(x >> 4, z >> 4)) {
            return false;
        }
        let dx = x as f64 + 0.5 - client.pos[0];
        let dy = y as f64 + 0.5 - client.pos[1];
        let dz = z as f64 + 0.5 - client.pos[2];
        dx * dx + dy * dy + dz * dz <= MAX_REACH * MAX_REACH
    }

    fn broadcast_block(&mut self, x: i32, y: i32, z: i32, state: u16) {
        let bytes = S2C::BlockUpdate { x, y, z, state }.encode();
        let chunk = (x >> 4, z >> 4);
        for (id, client) in &self.clients {
            if client.sent.contains(&chunk) {
                self.outbox.push((*id, bytes.clone()));
            }
        }
    }

    /// Makes sure the chunk is in memory. Returns false while it is still
    /// being fetched from the host's storage.
    fn ensure_chunk(&mut self, c: ChunkPos) -> bool {
        if self.world.chunks.contains_key(&c) {
            return true;
        }
        if self.stored.contains(&c) {
            if self.requested.insert(c) {
                self.requests.push(c);
            }
            return false;
        }
        let chunk = worldgen::generate(self.generator, self.seed, c.0, c.1);
        self.world.chunks.insert(c, chunk);
        self.stats.chunks_generated += 1;
        true
    }

    fn stream_chunks(&mut self) {
        let ids: Vec<u32> = self.clients.keys().copied().collect();

        // Forget chunks that left the view.
        for id in &ids {
            let client = self.clients.get_mut(id).unwrap();
            if !client.joined {
                continue;
            }
            let gone: Vec<ChunkPos> = client
                .sent
                .iter()
                .copied()
                .filter(|c| !client.in_view(*c))
                .collect();
            for c in gone {
                client.sent.remove(&c);
                self.outbox
                    .push((*id, S2C::UnloadChunk { cx: c.0, cz: c.1 }.encode()));
            }
        }

        // Send missing chunks, nearest first. The starting client rotates every
        // tick so nobody is starved when the shared budget runs out.
        let mut budget = CHUNK_SENDS_PER_TICK;
        let first = if ids.is_empty() {
            0
        } else {
            self.game_time as usize % ids.len()
        };
        for k in 0..ids.len() {
            if budget == 0 {
                break;
            }
            let id = &ids[(first + k) % ids.len()];
            let client = &self.clients[id];
            if !client.joined {
                continue;
            }
            let (cx, cz) = client.center();
            let view = client.view;
            let mut missing: Vec<(i32, ChunkPos)> = Vec::new();
            for dz in -view..=view {
                for dx in -view..=view {
                    let c = (cx + dx, cz + dz);
                    if !client.sent.contains(&c) {
                        missing.push((dx * dx + dz * dz, c));
                    }
                }
            }
            // The distance ties are broken by coordinate, so the order is total.
            missing.sort();
            let mut sent = 0;
            for (_, c) in missing {
                if budget == 0 || sent == CHUNK_SENDS_PER_CLIENT {
                    break;
                }
                if !self.ensure_chunk(c) {
                    continue;
                }
                let data = self.world.chunks[&c].to_bytes();
                self.outbox.push((
                    *id,
                    S2C::ChunkData {
                        cx: c.0,
                        cz: c.1,
                        data,
                    }
                    .encode(),
                ));
                self.clients.get_mut(id).unwrap().sent.insert(c);
                budget -= 1;
                sent += 1;
            }
        }
    }

    fn unload_far_chunks(&mut self) {
        let clients = &self.clients;
        self.world.chunks.retain(|&(cx, cz), chunk| {
            chunk.dirty
                || clients.values().any(|c| {
                    let (px, pz) = c.center();
                    let r = c.view + UNLOAD_MARGIN;
                    (cx - px).abs() <= r && (cz - pz).abs() <= r
                })
        });
    }

    pub fn take_outbox(&mut self) -> Vec<(u32, Vec<u8>)> {
        std::mem::take(&mut self.outbox)
    }

    // ---- storage -----------------------------------------------------------

    /// Tells the core which chunks the host has saved. Call once at startup.
    pub fn set_stored(&mut self, coords: impl IntoIterator<Item = ChunkPos>) {
        self.stored = coords.into_iter().collect();
    }

    /// Chunks the core wants loaded. Answer each with `load_chunk`.
    pub fn take_requests(&mut self) -> Vec<ChunkPos> {
        std::mem::take(&mut self.requests)
    }

    /// Delivers a stored chunk. Corrupt data is discarded and the chunk is
    /// regenerated from the seed instead. Returns whether the bytes were used.
    pub fn load_chunk(&mut self, cx: i32, cz: i32, bytes: &[u8]) -> bool {
        let c = (cx, cz);
        self.requested.remove(&c);
        if self.world.chunks.contains_key(&c) {
            return false;
        }
        match Chunk::read(cx, cz, &mut Reader::new(bytes)) {
            Ok(chunk) => {
                self.world.chunks.insert(c, chunk);
                self.stats.chunks_loaded_from_storage += 1;
                true
            }
            Err(_) => {
                self.stored.remove(&c);
                false
            }
        }
    }

    /// The host could not find a chunk it had announced; regenerate it.
    pub fn chunk_missing(&mut self, cx: i32, cz: i32) {
        self.requested.remove(&(cx, cz));
        self.stored.remove(&(cx, cz));
    }

    /// Next chunk that needs saving, serialized. The chunk counts as saved
    /// once this returns, so the host must persist it.
    pub fn take_dirty(&mut self) -> Option<(i32, i32, Vec<u8>)> {
        let chunk = self.world.chunks.values_mut().find(|c| c.dirty)?;
        chunk.dirty = false;
        self.stored.insert((chunk.cx, chunk.cz));
        Some((chunk.cx, chunk.cz, chunk.to_bytes()))
    }

    pub fn dirty_chunks(&self) -> usize {
        self.world.chunks.values().filter(|c| c.dirty).count()
    }

    // ---- inspection --------------------------------------------------------

    pub fn get_block(&self, x: i32, y: i32, z: i32) -> Option<u16> {
        self.world.get_block(x, y, z)
    }

    /// Fingerprint of the clock and every loaded block.
    pub fn state_hash(&self) -> u64 {
        let mut h = Fnv64::new();
        h.i64(self.seed);
        h.i64(self.game_time);
        h.i64(self.day_time);
        self.world.hash_into(&mut h);
        h.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::PROTOCOL_VERSION;

    fn joined(view: u8) -> Server {
        let mut s = Server::new(1, Generator::DebugHills);
        s.connect(1);
        s.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: view,
            }
            .encode(),
        );
        s
    }

    fn decode_all(out: Vec<(u32, Vec<u8>)>) -> Vec<(u32, S2C)> {
        out.into_iter()
            .map(|(id, b)| (id, S2C::decode(&b).unwrap()))
            .collect()
    }

    #[test]
    fn join_streams_every_chunk_in_view_exactly_once() {
        let mut s = joined(3);
        let mut chunks = BTreeSet::new();
        let mut welcomes = 0;
        for _ in 0..40 {
            s.tick();
            for (_, p) in decode_all(s.take_outbox()) {
                match p {
                    S2C::Welcome { view_distance, .. } => {
                        welcomes += 1;
                        assert_eq!(view_distance, 3);
                    }
                    S2C::ChunkData { cx, cz, data } => {
                        assert!(chunks.insert((cx, cz)), "chunk {cx},{cz} sent twice");
                        assert!(Chunk::read(cx, cz, &mut Reader::new(&data)).is_ok());
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(welcomes, 1);
        assert_eq!(chunks.len(), 7 * 7);
        assert!(chunks.contains(&(-3, -3)) && chunks.contains(&(3, 3)));
    }

    #[test]
    fn time_update_once_per_second() {
        let mut s = joined(2);
        let mut times = Vec::new();
        for _ in 0..100 {
            s.tick();
            for (_, p) in decode_all(s.take_outbox()) {
                if let S2C::TimeUpdate { game_time, .. } = p {
                    times.push(game_time);
                }
            }
        }
        assert_eq!(times, vec![20, 40, 60, 80, 100]);
    }

    #[test]
    fn block_edits_are_validated_and_broadcast() {
        let mut s = joined(2);
        s.connect(2);
        s.handle_packet(
            2,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        for _ in 0..20 {
            s.tick();
        }
        s.take_outbox();
        let [sx, sy, sz] = s.spawn();
        let (bx, by, bz) = (sx.floor() as i32, sy as i32 + 2, sz.floor() as i32);

        // In reach: applied and sent to both players.
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: bx,
                y: by,
                z: bz,
                state: blocks::BRICKS,
            }
            .encode(),
        );
        // Out of reach, unknown block id, outside build height: all refused.
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: bx + 30,
                y: by,
                z: bz,
                state: blocks::BRICKS,
            }
            .encode(),
        );
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: bx,
                y: by + 1,
                z: bz,
                state: 999,
            }
            .encode(),
        );
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: bx,
                y: 320,
                z: bz,
                state: blocks::BRICKS,
            }
            .encode(),
        );
        s.handle_packet(1, &[0xEE, 1, 2]);
        s.tick();

        let updates: Vec<(u32, S2C)> = decode_all(s.take_outbox())
            .into_iter()
            .filter(|(_, p)| matches!(p, S2C::BlockUpdate { .. }))
            .collect();
        let expected = S2C::BlockUpdate {
            x: bx,
            y: by,
            z: bz,
            state: blocks::BRICKS,
        };
        assert_eq!(updates, vec![(1, expected.clone()), (2, expected)]);
        assert_eq!(s.get_block(bx, by, bz), Some(blocks::BRICKS));
        assert_eq!(s.get_block(bx, by + 1, bz), Some(blocks::AIR));
        assert_eq!(s.stats.blocks_changed, 1);
        assert_eq!(s.stats.packets_rejected, 4);
    }

    #[test]
    fn moving_unloads_old_chunks_and_loads_new_ones() {
        let mut s = joined(2);
        for _ in 0..20 {
            s.tick();
        }
        s.take_outbox();
        s.handle_packet(
            1,
            &C2S::PlayerPos {
                x: 160.5,
                y: 80.0,
                z: 0.5,
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode(),
        );
        let (mut loaded, mut unloaded) = (BTreeSet::new(), BTreeSet::new());
        for _ in 0..20 {
            s.tick();
            for (_, p) in decode_all(s.take_outbox()) {
                match p {
                    S2C::ChunkData { cx, cz, .. } => {
                        loaded.insert((cx, cz));
                    }
                    S2C::UnloadChunk { cx, cz } => {
                        unloaded.insert((cx, cz));
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(unloaded.len(), 25);
        assert_eq!(loaded.len(), 25);
        assert!(loaded
            .iter()
            .all(|&(cx, cz)| (8..=12).contains(&cx) && (-2..=2).contains(&cz)));
    }

    #[test]
    fn edits_survive_save_unload_and_reload() {
        let mut s = joined(2);
        for _ in 0..20 {
            s.tick();
        }
        let [sx, sy, sz] = s.spawn();
        let (bx, by, bz) = (sx.floor() as i32, sy as i32 + 1, sz.floor() as i32);
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: bx,
                y: by,
                z: bz,
                state: blocks::OAK_PLANKS,
            }
            .encode(),
        );
        s.tick();

        // Host saves.
        let mut disk = BTreeMap::new();
        while let Some((cx, cz, bytes)) = s.take_dirty() {
            disk.insert((cx, cz), bytes);
        }
        assert_eq!(disk.len(), 1);
        assert_eq!(s.dirty_chunks(), 0);

        // Walk far away until the chunk is dropped from memory.
        s.handle_packet(
            1,
            &C2S::PlayerPos {
                x: 1000.5,
                y: 80.0,
                z: 0.5,
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode(),
        );
        for _ in 0..200 {
            s.tick();
        }
        s.take_outbox();
        assert_eq!(s.get_block(bx, by, bz), None, "chunk should be unloaded");

        // Come back: the core asks the host instead of regenerating.
        s.handle_packet(
            1,
            &C2S::PlayerPos {
                x: sx,
                y: sy,
                z: sz,
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode(),
        );
        let mut asked = Vec::new();
        for _ in 0..40 {
            s.tick();
            for (cx, cz) in s.take_requests() {
                asked.push((cx, cz));
                assert!(s.load_chunk(cx, cz, &disk[&(cx, cz)]));
            }
        }
        assert_eq!(asked, vec![(bx >> 4, bz >> 4)]);
        assert_eq!(s.get_block(bx, by, bz), Some(blocks::OAK_PLANKS));
        assert_eq!(s.stats.chunks_loaded_from_storage, 1);
    }

    #[test]
    fn corrupt_storage_falls_back_to_generation() {
        let mut s = Server::new(1, Generator::DebugHills);
        s.set_stored([(0, 0)]);
        s.connect(1);
        s.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        s.tick();
        assert_eq!(s.take_requests(), vec![(0, 0)]);
        assert!(!s.load_chunk(0, 0, &[1, 2, 3]));
        for _ in 0..10 {
            s.tick();
        }
        assert!(s.get_block(0, -64, 0) == Some(blocks::BEDROCK));
    }

    #[test]
    fn wrong_protocol_version_never_joins() {
        let mut s = Server::new(1, Generator::Flat);
        s.connect(1);
        s.handle_packet(
            1,
            &C2S::Hello {
                protocol: 999,
                view_distance: 4,
            }
            .encode(),
        );
        for _ in 0..25 {
            s.tick();
        }
        assert!(s.take_outbox().is_empty());
    }
}
