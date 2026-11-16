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

// Creative sprint flight tends to 0.98 * 0.1 / (1 - 0.91) = 1.089;
// gravity tends to 0.08 * 0.98 / (1 - 0.98) = 3.92 blocks/tick.
// Margins cover rounding and timing jitter; reserve up to two seconds.
const HORIZONTAL_PER_TICK: f64 = 1.5;
const VERTICAL_PER_TICK: f64 = 4.5;
const MOVEMENT_RESERVE: f64 = 40.0;
const COLLISION_TOLERANCE: f64 = 0.1;

type ChunkPos = (i32, i32);

struct Client {
    joined: bool,
    view: i32,
    pos: [f64; 3],
    sent: BTreeSet<ChunkPos>,
    allow_teleport: bool,
    accepted_tick: i64,
    budget_tick: i64,
    horizontal_budget: f64,
    vertical_budget: f64,
    correction_tick: Option<i64>,
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
    pub positions_rejected: u64,
    pub blocks_changed: u64,
    pub edits_corrected: u64,
    pub chunks_generated: u64,
    pub chunks_generated_externally: u64,
    pub chunks_loaded_from_storage: u64,
}

pub struct Server {
    seed: i64,
    generator: Generator,
    terrain: Option<worldgen::TerrainGenerator>,
    spawn: [f64; 3],
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
    max_generation_in_flight: usize,
    generating: BTreeSet<ChunkPos>,
    generation_requests: Vec<ChunkPos>,
    pub stats: Stats,
}

impl Server {
    pub fn new(seed: i64, generator: Generator) -> Self {
        let terrain =
            (generator == Generator::Terrain).then(|| worldgen::TerrainGenerator::new(seed));
        let [x, y, z] = worldgen::spawn_point(generator, seed);
        Self {
            seed,
            generator,
            terrain,
            spawn: [x as f64 + 0.5, y as f64, z as f64 + 0.5],
            game_time: 0,
            day_time: 0,
            // Lighting is unused by simulation until mob spawning needs it.
            world: World::with_lighting(false),
            clients: BTreeMap::new(),
            pending: Vec::new(),
            outbox: Vec::new(),
            stored: BTreeSet::new(),
            requested: BTreeSet::new(),
            requests: Vec::new(),
            max_generation_in_flight: 0,
            generating: BTreeSet::new(),
            generation_requests: Vec::new(),
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

    /// Biome at the last server-accepted player column (spawn before connection).
    pub fn client_biome(&self, id: u32) -> &'static str {
        let [x, _, z] = self.client_position(id).unwrap_or(self.spawn);
        let biome = match &self.terrain {
            Some(t) => t.biome_at(x.floor() as i32, z.floor() as i32),
            None => worldgen::biome_at(
                self.generator,
                self.seed,
                x.floor() as i32,
                z.floor() as i32,
            ),
        };
        world::biomes::BIOMES[biome as usize].name
    }

    pub fn client_count(&self) -> usize {
        self.clients.len()
    }

    pub fn spawn(&self) -> [f64; 3] {
        self.spawn
    }

    pub fn connect(&mut self, id: u32) {
        self.connect_with_teleport(id, false);
    }

    /// Permission is supplied by the trusted host, never by a wire packet.
    pub fn connect_with_teleport(&mut self, id: u32, allow_teleport: bool) {
        self.connect_at(id, allow_teleport, None);
    }

    /// Restore a trusted host's last accepted feet position on reconnect.
    /// Invalid coordinates fall back to spawn; no chunk load is required here.
    pub fn connect_at(&mut self, id: u32, allow_teleport: bool, position: Option<[f64; 3]>) {
        let pos = position
            .filter(|p| valid_position(*p))
            .unwrap_or_else(|| self.spawn());
        self.clients.insert(
            id,
            Client {
                joined: false,
                view: DEFAULT_VIEW_DISTANCE,
                pos,
                sent: BTreeSet::new(),
                allow_teleport,
                accepted_tick: self.game_time,
                budget_tick: self.game_time,
                horizontal_budget: HORIZONTAL_PER_TICK * MOVEMENT_RESERVE,
                vertical_budget: VERTICAL_PER_TICK * MOVEMENT_RESERVE,
                correction_tick: None,
            },
        );
    }

    /// Last accepted position, never a queued or rejected client report.
    pub fn client_position(&self, id: u32) -> Option<[f64; 3]> {
        self.clients.get(&id).map(|client| client.pos)
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
                self.move_player(id, [x, y, z], false);
            }
            C2S::Teleport { x, y, z } => {
                self.move_player(id, [x, y, z], true);
            }
            C2S::SetBlock { x, y, z, state } => {
                if !self.can_edit(id, x, y, z, state) {
                    self.stats.packets_rejected += 1;
                    self.correct_block(id, x, y, z);
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

    fn move_player(&mut self, id: u32, pos: [f64; 3], teleport: bool) {
        let Some(client) = self.clients.get_mut(&id) else {
            return;
        };
        if !client.joined {
            self.stats.packets_rejected += 1;
            return;
        }
        let elapsed = (self.game_time - client.budget_tick).max(0) as f64;
        client.budget_tick = self.game_time;
        client.horizontal_budget = (client.horizontal_budget + elapsed * HORIZONTAL_PER_TICK)
            .min(HORIZONTAL_PER_TICK * MOVEMENT_RESERVE);
        client.vertical_budget = (client.vertical_budget + elapsed * VERTICAL_PER_TICK)
            .min(VERTICAL_PER_TICK * MOVEMENT_RESERVE);
        let delta = std::array::from_fn::<_, 3, _>(|a| pos[a] - client.pos[a]);
        let horizontal = (delta[0] * delta[0] + delta[2] * delta[2]).sqrt();
        let vertical = delta[1].abs();
        // Bound Y too: collision cell iteration must remain finite and bounded.
        let finite = valid_position(pos);
        let permitted = if teleport {
            client.allow_teleport
        } else {
            horizontal <= client.horizontal_budget
                && vertical <= client.vertical_budget
                && finite
                && movement_clear(&self.world, client.pos, pos)
        };
        if finite && permitted {
            client.pos = pos;
            client.accepted_tick = self.game_time;
            if teleport {
                client.horizontal_budget = HORIZONTAL_PER_TICK * MOVEMENT_RESERVE;
                client.vertical_budget = VERTICAL_PER_TICK * MOVEMENT_RESERVE;
            } else {
                client.horizontal_budget -= horizontal;
                client.vertical_budget -= vertical;
            }
        } else {
            self.stats.packets_rejected += 1;
            self.stats.positions_rejected += 1;
            if client.correction_tick != Some(self.game_time) {
                client.correction_tick = Some(self.game_time);
                let [x, y, z] = client.pos;
                self.outbox
                    .push((id, S2C::PlayerCorrect { x, y, z }.encode()));
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
            && self.world.get_block(x, y, z).is_some_and(|old| {
                blocks::can_place(
                    old,
                    state,
                    self.world.get_block(x, y - 1, z).unwrap_or(blocks::AIR),
                )
            })
    }

    fn correct_block(&mut self, id: u32, x: i32, y: i32, z: i32) {
        let (joined, sent) = match self.clients.get(&id) {
            Some(client) => (client.joined, client.sent.contains(&(x >> 4, z >> 4))),
            None => return,
        };
        if !joined || !sent || !(MIN_Y..MIN_Y + HEIGHT).contains(&y) {
            return;
        }
        if let Some(state) = self.world.get_block(x, y, z) {
            self.outbox
                .push((id, S2C::BlockUpdate { x, y, z, state }.encode()));
            self.stats.edits_corrected += 1;
        }
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
    /// being fetched from storage or generated by the host.
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
        if self.max_generation_in_flight != 0 {
            if self.generating.len() < self.max_generation_in_flight && self.generating.insert(c) {
                self.generation_requests.push(c);
            }
            return false;
        }
        self.generate_now(c.0, c.1);
        true
    }

    /// Zero disables external generation. Existing requests can still be delivered.
    pub fn set_external_generation(&mut self, max_in_flight: usize) {
        self.max_generation_in_flight = max_in_flight;
    }

    /// Draining the queue does not release in-flight slots.
    pub fn take_generation_requests(&mut self) -> Vec<ChunkPos> {
        std::mem::take(&mut self.generation_requests)
    }

    fn finish_generation_request(&mut self, c: ChunkPos) {
        self.generating.remove(&c);
        self.generation_requests.retain(|&queued| queued != c);
    }

    /// Accept generated bytes, or synchronously regenerate corrupt input.
    /// Existing chunks (including edits) are never overwritten.
    pub fn deliver_generated(&mut self, cx: i32, cz: i32, bytes: &[u8]) -> bool {
        self.finish_generation_request((cx, cz));
        if self.world.chunks.contains_key(&(cx, cz)) {
            return false;
        }
        match Chunk::read(cx, cz, &mut Reader::new(bytes)) {
            Ok(chunk) => {
                self.world.insert_chunk(chunk);
                self.stats.chunks_generated += 1;
                self.stats.chunks_generated_externally += 1;
                true
            }
            Err(_) => {
                self.generate_now(cx, cz);
                false
            }
        }
    }

    /// Synchronous fallback; also completes any external request for this chunk.
    pub fn generate_now(&mut self, cx: i32, cz: i32) {
        let c = (cx, cz);
        self.finish_generation_request(c);
        if self.world.chunks.contains_key(&c) {
            return;
        }
        let chunk = match &self.terrain {
            Some(terrain) => terrain.generate(c.0, c.1),
            None => worldgen::generate(self.generator, self.seed, c.0, c.1),
        };
        self.world.insert_chunk(chunk);
        self.stats.chunks_generated += 1;
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
        let removed: Vec<_> = self
            .world
            .chunks
            .iter()
            .filter_map(|(&(cx, cz), chunk)| {
                let keep = chunk.dirty
                    || clients.values().any(|c| {
                        let (px, pz) = c.center();
                        let r = c.view + UNLOAD_MARGIN;
                        (cx - px).abs() <= r && (cz - pz).abs() <= r
                    });
                (!keep).then_some((cx, cz))
            })
            .collect();
        for (cx, cz) in removed {
            self.world.remove_chunk(cx, cz);
        }
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
                self.world.insert_chunk(chunk);
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

fn valid_position(pos: [f64; 3]) -> bool {
    pos.iter().all(|v| v.is_finite() && v.abs() < 2.9999984e7)
}

// Unknown chunks are solid, just as in client prediction. No terrain is
// generated on demand by a movement packet (including stored chunks in flight).
fn movement_clear(world: &World, from: [f64; 3], to: [f64; 3]) -> bool {
    let origin = physics::Player::new(from).bounds();
    struct MovementWorld<'a>(&'a World, physics::Aabb);
    impl physics::CollisionWorld for MovementWorld<'_> {
        fn collision_boxes(&self, x: i32, y: i32, z: i32, visit: &mut dyn FnMut(physics::Aabb)) {
            let unknown = self.0.get_block(x, y, z).is_none();
            physics::BlockWorld(|x, y, z| self.0.get_block(x, y, z)).collision_boxes(
                x,
                y,
                z,
                &mut |b| {
                    if unknown || !self.1.intersects(b) {
                        visit(b);
                    }
                },
            );
        }
    }
    let collisions = MovementWorld(world, origin);
    let target = physics::Player::new(to);
    if !target.is_clear(&collisions) {
        return false;
    }
    let delta = std::array::from_fn::<_, 3, _>(|a| to[a] - from[a]);
    // Split only within each axis: a full-reserve report has bounded broad
    // phases without turning the path into a diagonal staircase through solids.
    let sweep = |mut player: physics::Player, destination: [f64; 3], axes: &[usize]| {
        let start = player.position;
        for &axis in axes {
            let steps = (destination[axis] - start[axis]).abs().ceil().max(1.0) as usize;
            for i in 1..=steps {
                let mut desired = [0.0; 3];
                desired[axis] = start[axis]
                    + (destination[axis] - start[axis]) * i as f64 / steps as f64
                    - player.position[axis];
                let actual = physics::resolve(&collisions, player.bounds(), desired);
                if (actual[axis] - desired[axis]).abs() >= COLLISION_TOLERANCE {
                    return None;
                }
                player.position[axis] += actual[axis];
            }
        }
        Some(player)
    };
    // Prefer prediction's ordinary Y/X/Z path.
    if sweep(physics::Player::new(from), to, &[1, 0, 2]).is_some() {
        return true;
    }
    // Validate only the step route's geometry. Inferring ground/landing state
    // from endpoints can reject valid prediction; tracking velocity is future
    // work. This also permits a modified client to use a step while airborne.
    // Prediction can also step up, move X/Z, then descend. Resolve the upward
    // leg first so low ceilings limit the rise exactly as in Player::tick.
    let up = physics::resolve(&collisions, origin, [0.0, physics::STEP_HEIGHT, 0.0])[1];
    if up <= 0.0 || delta[1] > up {
        return false;
    }
    let raised = physics::Player::new([from[0], from[1] + up, from[2]]);
    if !raised.is_clear(&collisions) {
        return false;
    }
    let Some(across) = sweep(raised, [to[0], raised.position[1], to[2]], &[0, 2]) else {
        return false;
    };
    if !across.is_clear(&collisions) {
        return false;
    }
    sweep(across, to, &[1]).is_some_and(|landed| landed.is_clear(&collisions))
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

    fn position_packet(pos: [f64; 3]) -> Vec<u8> {
        C2S::PlayerPos {
            x: pos[0],
            y: pos[1],
            z: pos[2],
            yaw: 0.0,
            pitch: 0.0,
        }
        .encode()
    }

    #[test]
    fn terrain_spawn_and_prepared_chunks_match_worldgen() {
        for seed in [0, 2026, -71] {
            let mut server = Server::new(seed, Generator::Terrain);
            let [x, y, z] = worldgen::spawn_point(Generator::Terrain, seed);
            assert_eq!(server.spawn(), [x as f64 + 0.5, y as f64, z as f64 + 0.5]);
            assert!(y > worldgen::SEA_LEVEL + 1);
            let coords = (x.div_euclid(16), z.div_euclid(16));
            assert!(server.ensure_chunk(coords));
            assert_eq!(
                server.world.chunks[&coords],
                worldgen::generate(Generator::Terrain, seed, coords.0, coords.1)
            );
            assert_eq!(server.spawn(), server.spawn);
            assert!(server.terrain.is_some());
        }
        assert!(Server::new(2026, Generator::DebugHills).terrain.is_none());
    }

    #[test]
    fn registry_shape_prediction_paths_are_accepted_by_server() {
        for (obstacle, roof, passes) in [
            (blocks::OAK_SLAB, false, true),
            (blocks::OAK_SLAB + 2, false, false),
            (blocks::OAK_SLAB + 1, true, true),
            (blocks::OAK_SLAB, true, false),
            (blocks::RED_FLOWER, false, true),
            (blocks::YELLOW_FLOWER, false, true),
            (blocks::SHORT_GRASS, false, true),
            (blocks::OAK_STAIRS + 6, false, true),
            (blocks::COBBLESTONE_STAIRS + 6, false, true),
            (blocks::OAK_FENCE, false, true),
        ] {
            let floor = if roof { 63.5 } else { 64.0 };
            let mut s = joined_at([0.5, floor, 1.5]);
            for x in 0..16 {
                for z in 0..16 {
                    s.world.set_block(
                        x,
                        63,
                        z,
                        if roof {
                            blocks::OAK_SLAB
                        } else {
                            blocks::STONE
                        },
                    );
                }
            }
            s.world
                .set_block(1, if roof { 65 } else { 64 }, 1, obstacle);
            let mut player = physics::Player::new([0.5, floor, 1.5]);
            let mut highest = floor;
            for _ in 0..18 {
                let before = player.position;
                player.tick(
                    physics::Input {
                        strafe: -1.0,
                        ..Default::default()
                    },
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
                highest = highest.max(player.position[1]);
                assert!(movement_clear(&s.world, before, player.position));
                s.handle_packet(1, &position_packet(player.position));
                s.tick();
                assert_eq!(s.client_position(1), Some(player.position));
            }
            assert_eq!(s.stats.positions_rejected, 0);
            assert_eq!(
                player.position[0] > 1.0,
                passes,
                "state {obstacle}, roof {roof}"
            );
            if obstacle == blocks::OAK_FENCE {
                assert!(player.position[0] < 1.1);
            }
            if obstacle == blocks::OAK_SLAB && !roof {
                assert_eq!(highest, 64.5);
            }
        }
    }

    #[test]
    fn fence_jump_prediction_stays_blocked_but_airborne_step_routes_are_accepted() {
        let mut s = joined_at([0.5, 64.0, 1.5]);
        for x in 0..16 {
            for z in 0..16 {
                s.world.set_block(x, 63, z, blocks::STONE);
                if x == 1 {
                    s.world.set_block(x, 64, z, blocks::OAK_FENCE);
                }
            }
        }
        let mut player = physics::Player::new([0.5, 64.0, 1.5]);
        let mut highest = 64.0_f64;
        for _ in 0..60 {
            let before = player.position;
            player.tick(
                physics::Input {
                    strafe: -1.0,
                    jump: true,
                    ..Default::default()
                },
                &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
            );
            highest = highest.max(player.position[1]);
            assert!(player.position[0] < 1.1);
            assert!(movement_clear(&s.world, before, player.position));
            s.handle_packet(1, &position_packet(player.position));
            s.tick();
            assert_eq!(s.client_position(1), Some(player.position));
        }
        assert!(highest > 65.25 && highest < 65.26);
        assert_eq!(s.stats.positions_rejected, 0);
        // Normal prediction above cannot jump the 1.5-high fence. The server
        // deliberately validates only space, so its extra up/across/down route
        // accepts these airborne crossings without inferring velocity/support.
        assert!(movement_clear(&s.world, [0.5, 65.1, 1.5], [2.5, 65.1, 1.5]));
        for target_y in [65.1, 65.2522, 65.35] {
            // The spatial step route is clear for downward, horizontal and
            // upward reports from the jump apex alike.
            assert!(movement_clear(
                &s.world,
                [0.5, 65.2522, 1.5],
                [2.5, target_y, 1.5]
            ));
        }
        // A clear descent onto support is accepted even with nothing close
        // beneath the origin; support is not a prerequisite for this route.
        s.world.set_block(2, 64, 1, blocks::STONE);
        assert!(movement_clear(&s.world, [0.5, 65.7, 1.5], [2.5, 65.0, 1.5]));
        assert!(movement_clear(&s.world, [0.5, 65.5, 1.5], [2.5, 65.5, 1.5]));
    }

    #[test]
    fn water_is_passable_and_replaceable_but_glass_and_leaves_are_solid() {
        let mut s = flat_server();
        let from = [0.5, 70.0, 0.5];
        let to = [2.5, 70.0, 0.5];
        for material in [blocks::WATER, blocks::GLASS, blocks::OAK_LEAVES] {
            s.world.set_block(2, 70, 0, material);
            assert_eq!(
                movement_clear(&s.world, from, to),
                material == blocks::WATER
            );
        }
        let pos = s.clients[&1].pos;
        let (x, y, z) = (
            pos[0].floor() as i32,
            pos[1].floor() as i32,
            pos[2].floor() as i32,
        );
        for material in [
            blocks::WATER,
            blocks::GLASS,
            blocks::OAK_LEAVES,
            blocks::STONE,
        ] {
            assert!(s.can_edit(1, x, y, z, material));
            s.handle_packet(
                1,
                &C2S::SetBlock {
                    x,
                    y,
                    z,
                    state: material,
                }
                .encode(),
            );
            s.tick();
            assert_eq!(s.get_block(x, y, z), Some(material));
        }
    }

    fn flat_server() -> Server {
        let mut s = Server::new(1, Generator::Flat);
        s.connect(1);
        s.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 3,
            }
            .encode(),
        );
        for _ in 0..20 {
            s.tick();
        }
        s.take_outbox();
        s
    }

    fn joined_at(position: [f64; 3]) -> Server {
        let mut s = Server::new(1, Generator::Flat);
        s.connect_at(1, false, Some(position));
        s.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 3,
            }
            .encode(),
        );
        for _ in 0..20 {
            s.tick();
        }
        s.take_outbox();
        s
    }

    #[test]
    fn diagonal_slab_corner_step_accepts_each_prediction_tick() {
        let start = [0.69, 64.0, 1.2];
        for batched in [false, true] {
            let mut s = joined_at(start);
            for x in 0..4 {
                for z in 0..4 {
                    s.world.set_block(x, 63, z, blocks::STONE);
                }
            }
            s.world.set_block(1, 64, 0, blocks::OAK_SLAB);
            let mut player = physics::Player::new(start);
            for _ in 0..2 {
                player.tick(
                    physics::Input::default(),
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
            }
            assert!(player.on_ground);
            player.velocity = [0.15, -0.0784, 0.15];
            let ordinary = physics::resolve(
                &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                player.bounds(),
                player.velocity,
            );
            assert!(player.velocity[0] - ordinary[0] > COLLISION_TOLERANCE);
            for tick in 0..8 {
                player.tick(
                    physics::Input::default(),
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
                if tick == 0 {
                    for (actual, expected) in player.position.into_iter().zip([0.84, 64.0, 1.35]) {
                        assert!((actual - expected).abs() < 1e-12);
                    }
                    assert!(player.on_ground);
                }
                s.handle_packet(1, &position_packet(player.position));
                if !batched {
                    s.tick();
                    assert_eq!(s.client_position(1), Some(player.position));
                    assert_eq!(s.stats.positions_rejected, 0, "tick {tick}");
                }
            }
            if batched {
                s.tick();
            }
            assert_eq!(s.stats.positions_rejected, 0);
            assert_eq!(s.client_position(1), Some(player.position));
        }
    }

    #[test]
    fn diagonal_slab_corner_landing_accepts_each_prediction_tick() {
        for floor in [0.0, 64.0] {
            let start = [0.69, floor + 0.8, 1.2];
            let mut s = joined_at(start);
            for x in 0..4 {
                for z in 0..4 {
                    s.world.set_block(x, floor as i32 - 1, z, blocks::STONE);
                    for y in floor as i32..floor as i32 + 4 {
                        s.world.set_block(x, y, z, blocks::AIR);
                    }
                }
            }
            s.world.set_block(1, floor as i32, 0, blocks::OAK_SLAB);
            let mut player = physics::Player::new(start);
            player.velocity = [0.15, -0.9, 0.15];
            assert!(!player.on_ground);
            let ordinary = physics::resolve(
                &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                player.bounds(),
                player.velocity,
            );
            assert!(player.velocity[0] - ordinary[0] > COLLISION_TOLERANCE);
            for tick in 0..8 {
                player.tick(
                    physics::Input::default(),
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
                if tick == 0 {
                    // The landing route clears the corner and finishes exactly
                    // on the floor, despite starting airborne with vy=-0.9.
                    for (actual, expected) in player.position.into_iter().zip([0.84, floor, 1.35]) {
                        assert!((actual - expected).abs() < 1e-12);
                    }
                    assert!(player.on_ground);
                }
                s.handle_packet(1, &position_packet(player.position));
                s.tick();
                assert_eq!(s.stats.positions_rejected, 0, "floor {floor}, tick {tick}");
                assert_eq!(s.client_position(1), Some(player.position));
            }
        }
    }

    #[test]
    fn falling_around_stone_corner_onto_slab_accepts_each_prediction_tick() {
        for (start_y, velocity_y) in [(65.2, -1.3), (64.4, -0.5)] {
            let start = [0.69, start_y, 1.2];
            let mut s = joined_at(start);
            for x in 0..4 {
                for z in 0..4 {
                    s.world.set_block(x, 63, z, blocks::STONE);
                }
            }
            s.world.set_block(1, 64, 0, blocks::STONE);
            s.world.set_block(1, 64, 1, blocks::OAK_SLAB);
            let mut player = physics::Player::new(start);
            player.velocity = [0.15, velocity_y, 0.15];
            assert!(!player.on_ground);
            let ordinary = physics::resolve(
                &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                player.bounds(),
                player.velocity,
            );
            assert!(player.velocity[0] - ordinary[0] > COLLISION_TOLERANCE);
            for tick in 0..8 {
                player.tick(
                    physics::Input::default(),
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
                if tick == 0 {
                    for (actual, expected) in player.position.into_iter().zip([0.84, 64.5, 1.35]) {
                        assert!((actual - expected).abs() < 1e-12);
                    }
                    assert!(player.on_ground);
                }
                s.handle_packet(1, &position_packet(player.position));
                s.tick();
                assert_eq!(
                    s.stats.positions_rejected, 0,
                    "start_y {start_y}, tick {tick}"
                );
                assert_eq!(s.client_position(1), Some(player.position));
            }
        }
    }

    #[test]
    fn step_route_cannot_cross_full_walls_low_ceilings_or_unknown_chunks() {
        let start = [0.69, 64.0, 1.2];
        for obstacle in ["wall", "ceiling", "unknown"] {
            let mut s = joined_at(start);
            for x in 0..4 {
                for z in 0..4 {
                    s.world.set_block(x, 63, z, blocks::STONE);
                }
            }
            let target = match obstacle {
                "wall" => {
                    for z in 0..4 {
                        s.world.set_block(1, 64, z, blocks::STONE);
                    }
                    [2.5, 64.0, 1.35]
                }
                "ceiling" => {
                    s.world.set_block(1, 64, 0, blocks::OAK_SLAB);
                    s.world.set_block(0, 66, 1, blocks::STONE);
                    [0.84, 64.0, 1.35]
                }
                _ => {
                    s.world.chunks.remove(&(1, 0));
                    [32.5, 64.0, 1.35]
                }
            };
            // The endpoint itself is empty: the intermediate route must fail.
            assert!(
                physics::Player::new(target)
                    .is_clear(&physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z))),
                "{obstacle}"
            );
            assert!(!movement_clear(&s.world, start, target), "{obstacle}");
            s.handle_packet(1, &position_packet(target));
            s.tick();
            assert_eq!(s.stats.positions_rejected, 1, "{obstacle}");
            assert_eq!(s.client_position(1), Some(start));
        }
    }

    #[test]
    fn descending_corner_accepts_each_physics_tick_including_batched_arrival() {
        let start = [0.69, 66.2, 0.5];
        for batched in [false, true] {
            let mut s = joined_at(start);
            s.world.set_block(0, 65, 0, blocks::BRICKS);
            let mut player = physics::Player::new(start);
            player.velocity = [0.8, -0.2, 0.0];
            for tick in 0..2 {
                let collisions = |x, y, z| {
                    s.world
                        .get_block(x, y, z)
                        .is_none_or(blocks::is_solid)
                        .then(|| physics::Aabb::block(x, y, z))
                };
                player.tick(
                    physics::Input {
                        flying: true,
                        ..Default::default()
                    },
                    &collisions,
                );
                assert!(player.is_clear(&collisions));
                if tick == 0 {
                    assert_eq!(player.position, [1.49, 66.0, 0.5]);
                }
                s.handle_packet(1, &position_packet(player.position));
                if !batched {
                    s.tick();
                }
            }
            assert!((player.position[0] - 2.218).abs() < 1e-6);
            assert!(player.position[1] < 65.9);
            if batched {
                s.tick();
            }
            assert_eq!(s.stats.positions_rejected, 0);
            assert_eq!(s.client_position(1), Some(player.position));

            // Omitting the intermediate report blocks the normal Y-first path,
            // but the spatial up/across/down route is still clear. Airborne
            // endpoints do not prevent the server from trying that route.
            let mut skipped = joined_at(start);
            skipped.world.set_block(0, 65, 0, blocks::BRICKS);
            skipped.handle_packet(1, &position_packet(player.position));
            skipped.tick();
            assert_eq!(skipped.stats.positions_rejected, 0);
            assert_eq!(skipped.client_position(1), Some(player.position));

            // A wall on the horizontal leg blocks both routes even though the
            // destination beyond it is clear.
            let mut blocked = joined_at(start);
            blocked.world.set_block(0, 65, 0, blocks::BRICKS);
            blocked.world.set_block(1, 66, 0, blocks::BRICKS);
            blocked.handle_packet(1, &position_packet(player.position));
            blocked.tick();
            assert_eq!(blocked.stats.positions_rejected, 1);
            assert_eq!(blocked.client_position(1), Some(start));
        }
    }

    #[test]
    fn rising_corner_reports_resolved_physics_not_interpolated_positions() {
        let start = [0.69, 64.9, 0.5];
        let mut s = joined_at(start);
        s.world.set_block(1, 64, 0, blocks::BRICKS);
        let mut player = physics::Player::new(start);
        player.velocity = [0.21, 0.4, 0.0];
        for tick in 0..5 {
            let collisions = |x, y, z| {
                s.world
                    .get_block(x, y, z)
                    .is_none_or(blocks::is_solid)
                    .then(|| physics::Aabb::block(x, y, z))
            };
            player.tick(
                physics::Input {
                    flying: true,
                    ..Default::default()
                },
                &collisions,
            );
            assert!(player.is_clear(&collisions));
            if tick == 0 {
                let rendered =
                    std::array::from_fn(|a| start[a] + (player.position[a] - start[a]) * 0.1);
                // Both physics endpoints are safe, but the camera's straight
                // interpolation crosses the corner. It must never be reported.
                assert!(!physics::Player::new(rendered).is_clear(&collisions));
            }
            s.handle_packet(1, &position_packet(player.position));
            s.tick();
            assert_eq!(s.stats.positions_rejected, 0, "tick {tick}");
            assert_eq!(s.client_position(1), Some(player.position));
        }
    }

    #[test]
    fn overlapping_placement_allows_gradual_escape_but_not_reentry_or_other_solids() {
        let start = [0.5, 65.0, 0.5];
        let mut s = joined_at(start);
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: 0,
                y: 65,
                z: 0,
                state: blocks::BRICKS,
            }
            .encode(),
        );
        s.tick();
        assert_eq!(s.get_block(0, 65, 0), Some(blocks::BRICKS));
        // A separate obstacle must still block movement while embedded.
        s.world.set_block(0, 65, 1, blocks::BRICKS);
        s.handle_packet(1, &position_packet([0.5, 65.0, 1.1]));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 1);
        assert_eq!(s.client_position(1), Some(start));
        let mut player = physics::Player::new(start);
        for _ in 0..12 {
            let collisions = |x, y, z| {
                s.world
                    .get_block(x, y, z)
                    .is_none_or(blocks::is_solid)
                    .then(|| physics::Aabb::block(x, y, z))
            };
            player.tick(
                physics::Input {
                    strafe: -1.0,
                    flying: true,
                    ..Default::default()
                },
                &collisions,
            );
            s.handle_packet(1, &position_packet(player.position));
            s.tick();
            assert_eq!(s.stats.positions_rejected, 1);
            assert_eq!(s.client_position(1), Some(player.position));
        }
        assert!(player.position[0] - physics::WIDTH / 2.0 > 1.0);
        s.handle_packet(1, &position_packet(start));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 2);
        assert_eq!(s.client_position(1), Some(player.position));
    }

    #[test]
    fn falling_motion_completes_y_before_x() {
        let start = [0.65, 68.0, 0.5];
        let mut s = joined_at(start);
        s.world.set_block(1, 67, 0, blocks::BRICKS);
        let mut player = physics::Player::new(start);
        player.velocity = [0.28, -3.0, 0.0];
        let collisions = |x, y, z| {
            s.world
                .get_block(x, y, z)
                .is_none_or(blocks::is_solid)
                .then(|| physics::Aabb::block(x, y, z))
        };
        player.tick(physics::Input::default(), &collisions);
        assert_eq!(player.position, [0.93, 65.0, 0.5]);
        s.handle_packet(1, &position_packet(player.position));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 0);
        assert_eq!(s.client_position(1), Some(player.position));
    }

    #[test]
    fn fast_diagonal_motion_completes_x_before_z_and_cannot_tunnel() {
        let start = [0.5, 65.0, 0.5];
        let mut s = joined_at(start);
        // The X-then-Z path goes around this obstacle; a diagonal crosses it.
        s.world.set_block(1, 65, 1, blocks::BRICKS);
        let mut player = physics::Player::new(start);
        player.velocity = [3.0, 0.0, 3.0];
        let collisions = |x, y, z| {
            s.world
                .get_block(x, y, z)
                .is_none_or(blocks::is_solid)
                .then(|| physics::Aabb::block(x, y, z))
        };
        player.tick(
            physics::Input {
                flying: true,
                ..Default::default()
            },
            &collisions,
        );
        assert_eq!(player.position, [3.5, 65.0, 3.5]);
        s.handle_packet(1, &position_packet(player.position));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 0);
        assert_eq!(s.client_position(1), Some(player.position));
        // A thin wall directly on the next X leg must clip even a fast report.
        s.world.set_block(5, 65, 3, blocks::BRICKS);
        s.handle_packet(1, &position_packet([8.5, 65.0, 8.5]));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 1);
        assert_eq!(s.client_position(1), Some(player.position));
    }

    #[test]
    fn reconnect_at_accepted_position_allows_nearby_movement_without_teleport() {
        let mut s = Server::new(1, Generator::Flat);
        let start = [3000.5, 100.0, -3000.5];
        s.connect_at(7, false, Some(start));
        assert_eq!(s.client_position(7), Some(start));
        s.handle_packet(
            7,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        s.tick(); // Stream the restored position's chunks before moving.
        let next = [start[0] + 0.2, start[1], start[2]];
        s.handle_packet(7, &position_packet(next));
        assert_eq!(s.client_position(7), Some(start)); // Pending is not accepted.
        s.tick();
        assert_eq!(s.client_position(7), Some(next));
        assert_eq!(s.stats.positions_rejected, 0);
        s.handle_packet(
            7,
            &C2S::Teleport {
                x: 0.5,
                y: 100.0,
                z: 0.5,
            }
            .encode(),
        );
        s.tick();
        assert_eq!(s.client_position(7), Some(next)); // Permission is still false.
        s.disconnect(7);
        assert_eq!(s.client_position(7), None);
    }

    #[test]
    fn invalid_initial_positions_fall_back_to_spawn() {
        let mut s = Server::new(1, Generator::Flat);
        s.connect_at(1, false, None);
        assert_eq!(s.client_position(1), Some(s.spawn()));
        for axis in 0..3 {
            for value in [
                f64::NAN,
                f64::INFINITY,
                f64::NEG_INFINITY,
                29_999_984.0,
                -29_999_984.0,
            ] {
                let mut position = [0.5, 100.0, 0.5];
                position[axis] = value;
                s.connect_at(1, false, Some(position));
                assert_eq!(s.client_position(1), Some(s.spawn()));
            }
        }
    }

    #[test]
    fn physics_trajectories_and_batched_packets_are_accepted() {
        for mode in 0..4 {
            for batch in [1, 8, 40] {
                let mut s = flat_server();
                let mut start = s.spawn();
                if mode == 3 {
                    start[1] += 1000.0;
                    s.clients.get_mut(&1).unwrap().allow_teleport = true;
                    s.handle_packet(
                        1,
                        &C2S::Teleport {
                            x: start[0],
                            y: start[1],
                            z: start[2],
                        }
                        .encode(),
                    );
                    s.tick();
                }
                let mut player = physics::Player::new(start);
                let mut packets = Vec::new();
                for t in 0..400 {
                    let collisions = |x, y, z| {
                        s.world
                            .get_block(x, y, z)
                            .is_none_or(blocks::is_solid)
                            .then(|| physics::Aabb::block(x, y, z))
                    };
                    player.tick(
                        physics::Input {
                            forward: if mode == 3 { 0.0 } else { 1.0 },
                            sprint: mode == 1 || mode == 2,
                            flying: mode == 2,
                            jump: mode != 3 && t % 40 == 10,
                            ..Default::default()
                        },
                        &collisions,
                    );
                    packets.push(position_packet(player.position));
                    if (t + 1) % batch == 0 {
                        for packet in packets.drain(..) {
                            s.handle_packet(1, &packet);
                        }
                    }
                    s.tick();
                    s.take_outbox();
                    assert_eq!(
                        s.stats.positions_rejected, 0,
                        "mode {mode}, batch {batch}, tick {t}"
                    );
                }
                assert_eq!(s.clients[&1].pos, player.position);
            }
        }
    }

    #[test]
    fn speed_budget_is_bounded_consumed_and_corrections_are_throttled() {
        let mut s = flat_server();
        let start = s.spawn();
        for _ in 0..100 {
            s.handle_packet(1, &position_packet([10000.0, start[1], 0.5]));
        }
        s.tick();
        assert_eq!(s.clients[&1].pos, start);
        assert_eq!(s.stats.positions_rejected, 100);
        let corrections: Vec<_> = decode_all(s.take_outbox())
            .into_iter()
            .filter(|(_, p)| matches!(p, S2C::PlayerCorrect { .. }))
            .collect();
        assert_eq!(
            corrections,
            vec![(
                1,
                S2C::PlayerCorrect {
                    x: start[0],
                    y: start[1],
                    z: start[2]
                }
            )]
        );
        s.handle_packet(1, &position_packet([start[0], start[1] + 181.0, start[2]]));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 101);
        assert_eq!(
            decode_all(s.take_outbox())
                .iter()
                .filter(|(_, p)| matches!(p, S2C::PlayerCorrect { .. }))
                .count(),
            1
        );
        // Many individually short packets in one tick cannot refill the bucket.
        // Keep the whole route loaded so only the speed budget can stop it.
        for cx in 0..=5 {
            assert!(s.ensure_chunk((cx, 0)));
        }
        for n in 1..=70 {
            s.handle_packet(
                1,
                &position_packet([start[0] + n as f64, start[1] + 3.0, start[2]]),
            );
        }
        s.tick();
        assert_eq!(s.clients[&1].pos[0], start[0] + 60.0);
        assert!(s.stats.positions_rejected > 101);
    }

    #[test]
    fn walls_overlap_and_unknown_chunks_are_rejected_but_prediction_support_is_optional() {
        let mut s = flat_server();
        let [x, y, z] = s.spawn();
        for by in y as i32..y as i32 + 4 {
            s.world.set_block(2, by, 0, blocks::BRICKS);
        }
        for target in [[4.5, y, z], [2.5, y, z]] {
            s.handle_packet(1, &position_packet(target));
            s.tick();
            assert_eq!(s.clients[&1].pos, [x, y, z]);
        }
        // A step up onto a predicted block that the server refused is valid air.
        s.handle_packet(1, &position_packet([x, y + 1.0, z + 1.0]));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 2);
        s.world.chunks.remove(&(0, 0));
        s.handle_packet(1, &position_packet([x, y + 1.0, z + 2.0]));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 3);
    }

    #[test]
    fn teleport_permission_is_host_only_and_resets_movement_origin() {
        for allowed in [false, true] {
            let mut s = flat_server();
            s.clients.get_mut(&1).unwrap().allow_teleport = allowed;
            let start = s.clients[&1].pos;
            let dest = [300.5, 100.0, 0.5];
            s.handle_packet(
                1,
                &C2S::Teleport {
                    x: dest[0],
                    y: dest[1],
                    z: dest[2],
                }
                .encode(),
            );
            s.tick();
            assert_eq!(s.clients[&1].pos, if allowed { dest } else { start });
            if allowed {
                s.handle_packet(1, &position_packet([301.0, 100.0, 0.5]));
                s.tick();
                assert_eq!(s.stats.positions_rejected, 0);
                assert_eq!(s.clients[&1].accepted_tick, s.game_time - 1);
            }
            s.handle_packet(
                1,
                &C2S::Teleport {
                    x: f64::NAN,
                    y: 100.0,
                    z: 0.5,
                }
                .encode(),
            );
            s.tick();
            assert!(s.stats.positions_rejected > 0);
        }
    }

    fn decode_all(out: Vec<(u32, Vec<u8>)>) -> Vec<(u32, S2C)> {
        out.into_iter()
            .map(|(id, b)| (id, S2C::decode(&b).unwrap()))
            .collect()
    }

    #[test]
    fn normal_ticks_do_not_allocate_lighting() {
        let mut s = Server::new(2026, Generator::DebugHills);
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
        assert!(!s.world.chunks.is_empty());
        assert!(!s.world.lighting_enabled());
        assert!(s.world.chunks.values().all(|c| c.lighting.is_none()));
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
    fn placement_allows_overwrites_but_validates_state_and_plant_support() {
        let mut s = joined(2);
        for _ in 0..20 {
            s.tick();
        }
        let [sx, sy, sz] = s.spawn();
        let (x, y, z) = (sx.floor() as i32, sy as i32 + 2, sz.floor() as i32);
        s.world.set_block(x, y - 1, z, blocks::AIR);
        for state in [
            blocks::STONE,
            blocks::OAK_SLAB,
            blocks::OAK_SLAB + 1,
            blocks::OAK_SLAB + 2,
            blocks::WATER,
        ] {
            s.handle_packet(1, &C2S::SetBlock { x, y, z, state }.encode());
            s.tick();
            assert_eq!(s.get_block(x, y, z), Some(state));
        }
        for state in [
            blocks::COUNT,
            u16::MAX,
            blocks::RED_FLOWER,
            blocks::YELLOW_FLOWER,
            blocks::SHORT_GRASS,
        ] {
            s.handle_packet(1, &C2S::SetBlock { x, y, z, state }.encode());
            s.tick();
            assert_eq!(s.get_block(x, y, z), Some(blocks::WATER));
        }
        for below in [blocks::OAK_SLAB, blocks::GLASS, blocks::WATER] {
            s.world.set_block(x, y - 1, z, below);
            assert!(!s.can_edit(1, x, y, z, blocks::RED_FLOWER));
        }
        s.world.set_block(x, y - 1, z, blocks::OAK_SLAB + 2);
        for state in [
            blocks::RED_FLOWER,
            blocks::YELLOW_FLOWER,
            blocks::SHORT_GRASS,
        ] {
            s.handle_packet(1, &C2S::SetBlock { x, y, z, state }.encode());
            s.tick();
            assert_eq!(s.get_block(x, y, z), Some(state));
        }
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

        let distant_before = s.get_block(bx + 30, by, bz).unwrap();

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
        assert_eq!(
            updates,
            vec![
                (1, expected.clone()),
                (2, expected),
                (
                    1,
                    S2C::BlockUpdate {
                        x: bx + 30,
                        y: by,
                        z: bz,
                        state: distant_before
                    }
                ),
                (
                    1,
                    S2C::BlockUpdate {
                        x: bx,
                        y: by + 1,
                        z: bz,
                        state: blocks::AIR
                    }
                ),
            ]
        );
        assert_eq!(s.get_block(bx + 30, by, bz), Some(distant_before));
        assert_eq!(s.stats.edits_corrected, 2);
        assert_eq!(s.get_block(bx, by, bz), Some(blocks::BRICKS));
        assert_eq!(s.get_block(bx, by + 1, bz), Some(blocks::AIR));
        assert_eq!(s.stats.blocks_changed, 1);
        assert_eq!(s.stats.packets_rejected, 4);
    }

    #[test]
    fn rejected_edits_correct_only_the_sender() {
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
        let (x, y, z) = (sx.floor() as i32, sy as i32 + 2, sz.floor() as i32);
        for (bx, state) in [(x + 20, blocks::BRICKS), (x, 999)] {
            let before = s.get_block(bx, y, z).unwrap();
            assert!(s.clients[&1].sent.contains(&(bx >> 4, z >> 4)));
            s.handle_packet(1, &C2S::SetBlock { x: bx, y, z, state }.encode());
            s.tick();
            let updates: Vec<_> = decode_all(s.take_outbox())
                .into_iter()
                .filter(|(_, p)| matches!(p, S2C::BlockUpdate { .. }))
                .collect();
            assert_eq!(
                updates,
                vec![(
                    1,
                    S2C::BlockUpdate {
                        x: bx,
                        y,
                        z,
                        state: before
                    }
                )]
            );
            assert_eq!(s.get_block(bx, y, z), Some(before));
        }
        assert_eq!(s.stats.blocks_changed, 0);
        assert_eq!(s.stats.packets_rejected, 2);
        assert_eq!(s.stats.edits_corrected, 2);
    }

    #[test]
    fn rejected_edits_without_client_chunk_are_not_corrected() {
        let mut s = Server::new(1, Generator::DebugHills);
        s.connect(1);
        let y = s.spawn()[1] as i32 + 2;
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: 0,
                y,
                z: 0,
                state: blocks::BRICKS,
            }
            .encode(),
        );
        s.tick();
        assert!(s.take_outbox().is_empty());
        s.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        s.tick();
        assert_eq!(s.clients[&1].sent.len(), 6);
        assert!(!s.clients[&1].sent.contains(&(2, 2)));
        let before = s.get_block(32, y, 32);
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: 32,
                y,
                z: 32,
                state: blocks::BRICKS,
            }
            .encode(),
        );
        s.tick();
        assert!(decode_all(s.take_outbox())
            .iter()
            .all(|(_, p)| !matches!(p, S2C::BlockUpdate { .. })));
        assert_eq!(s.get_block(32, y, 32), before);
        assert_eq!(s.stats.blocks_changed, 0);
        assert_eq!(s.stats.packets_rejected, 2);
        assert_eq!(s.stats.edits_corrected, 0);
    }

    #[test]
    fn rejected_edits_without_server_chunk_are_not_corrected() {
        let mut s = joined(2);
        for _ in 0..20 {
            s.tick();
        }
        s.take_outbox();
        let y = s.spawn()[1] as i32 + 2;
        assert!(s.clients[&1].sent.contains(&(0, 0)));
        s.world.remove_chunk(0, 0);
        s.handle_packet(
            1,
            &C2S::SetBlock {
                x: 0,
                y,
                z: 0,
                state: 999,
            }
            .encode(),
        );
        s.tick();
        assert_eq!(s.get_block(0, y, 0), None);
        assert!(decode_all(s.take_outbox())
            .iter()
            .all(|(_, p)| !matches!(p, S2C::BlockUpdate { .. })));
        assert_eq!(s.stats.edits_corrected, 0);
    }

    #[test]
    fn predicted_edits_converge_in_different_arrival_orders() {
        fn deliver(s: &mut Server, copies: &mut [World; 2]) {
            for (id, packet) in decode_all(s.take_outbox()) {
                let copy = &mut copies[id as usize - 1];
                match packet {
                    S2C::ChunkData { cx, cz, data } => {
                        copy.insert_chunk(Chunk::read(cx, cz, &mut Reader::new(&data)).unwrap());
                    }
                    S2C::BlockUpdate { x, y, z, state } => {
                        assert!(copy.set_block(x, y, z, state).is_some());
                    }
                    _ => {}
                }
            }
        }

        // 0: A accepted, 1: B accepted, 2: A rejected. Each inner slice is one tick.
        let schedules: &[&[&[usize]]] = &[
            &[&[0], &[1], &[2]],
            &[&[0], &[2], &[1]],
            &[&[1], &[0], &[2]],
            &[&[1], &[2], &[0]],
            &[&[2], &[0], &[1]],
            &[&[2], &[1], &[0]],
            &[&[0], &[2, 1]],
            &[&[0], &[1, 2]],
        ];
        for schedule in schedules {
            let mut s = joined(3);
            s.clients.get_mut(&1).unwrap().allow_teleport = true;
            s.connect_with_teleport(2, true);
            s.handle_packet(
                2,
                &C2S::Hello {
                    protocol: PROTOCOL_VERSION,
                    view_distance: 3,
                }
                .encode(),
            );
            let mut copies = [World::new(), World::new()];
            for _ in 0..20 {
                s.tick();
                deliver(&mut s, &mut copies);
            }
            let [sx, sy, sz] = s.spawn();
            let (x, y, z) = (sx.floor() as i32, sy as i32 + 2, sz.floor() as i32);
            let mut expected = s.get_block(x, y, z).unwrap();
            let mut accepted = 0;
            let mut rejected = 0;
            for actions in *schedule {
                for &action in *actions {
                    let (id, state) = match action {
                        0 => (1, blocks::BRICKS),
                        1 => (2, blocks::OAK_PLANKS),
                        2 => (1, blocks::OAK_LOG),
                        _ => unreachable!(),
                    };
                    s.handle_packet(
                        id,
                        &C2S::Teleport {
                            x: sx + if action == 2 { 20.0 } else { 0.0 },
                            y: sy,
                            z: sz,
                        }
                        .encode(),
                    );
                    assert_ne!(
                        copies[id as usize - 1].set_block(x, y, z, state),
                        Some(state)
                    );
                    s.handle_packet(id, &C2S::SetBlock { x, y, z, state }.encode());
                    if action == 2 {
                        rejected += 1;
                    } else {
                        expected = state;
                        accepted += 1;
                    }
                }
                s.tick();
                // A rejection never replaces the last accepted state with its prediction.
                assert_eq!(s.get_block(x, y, z), Some(expected));
                assert_eq!(s.stats.blocks_changed, accepted);
                assert_eq!(s.stats.edits_corrected, rejected);
                assert!(s.clients[&1].sent.contains(&(x >> 4, z >> 4)));
                deliver(&mut s, &mut copies);
                for copy in &copies {
                    assert_eq!(copy.get_block(x, y, z), s.get_block(x, y, z));
                }
            }
        }
    }

    #[test]
    fn moving_unloads_old_chunks_and_loads_new_ones() {
        let mut s = joined(2);
        s.clients.get_mut(&1).unwrap().allow_teleport = true;
        for _ in 0..20 {
            s.tick();
        }
        s.take_outbox();
        s.handle_packet(
            1,
            &C2S::Teleport {
                x: 160.5,
                y: 80.0,
                z: 0.5,
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
        s.clients.get_mut(&1).unwrap().allow_teleport = true;
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

        // Teleport far away until the chunk is dropped from memory.
        s.handle_packet(
            1,
            &C2S::Teleport {
                x: 1000.5,
                y: 80.0,
                z: 0.5,
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
            &C2S::Teleport {
                x: sx,
                y: sy,
                z: sz,
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
    fn external_stream_matches_synchronous_chunk_bytes() {
        for generator in [Generator::Flat, Generator::DebugHills, Generator::Terrain] {
            let mut synchronous = Server::new(2026, generator);
            let mut external = Server::new(2026, generator);
            external.set_external_generation(4);
            for server in [&mut synchronous, &mut external] {
                server.connect(1);
                server.handle_packet(
                    1,
                    &C2S::Hello {
                        protocol: PROTOCOL_VERSION,
                        view_distance: 2,
                    }
                    .encode(),
                );
            }
            let collect = |server: &mut Server, chunks: &mut BTreeMap<ChunkPos, Vec<u8>>| {
                for (_, packet) in decode_all(server.take_outbox()) {
                    if let S2C::ChunkData { cx, cz, data } = packet {
                        chunks.insert((cx, cz), data);
                    }
                }
            };
            let mut expected = BTreeMap::new();
            let mut actual = BTreeMap::new();
            for _ in 0..20 {
                synchronous.tick();
                external.tick();
                collect(&mut synchronous, &mut expected);
                collect(&mut external, &mut actual);
                for (cx, cz) in external.take_generation_requests() {
                    let bytes = worldgen::generate(generator, 2026, cx, cz).to_bytes();
                    assert!(external.deliver_generated(cx, cz, &bytes));
                }
            }
            assert_eq!(expected.len(), 25);
            assert_eq!(actual, expected);
            assert_eq!(external.stats.chunks_generated, 25);
            assert_eq!(external.stats.chunks_generated_externally, 25);
            assert_eq!(synchronous.stats.chunks_generated_externally, 0);
            assert_eq!(external.dirty_chunks(), 0);
            assert!(external.take_dirty().is_none());
        }
    }

    #[test]
    fn external_requests_are_nearest_first_unique_and_bounded() {
        let mut s = joined(2);
        s.set_external_generation(3);
        s.set_stored([(0, 0)]);
        s.tick();
        assert_eq!(s.take_requests(), vec![(0, 0)]);
        let requests = s.take_generation_requests();
        assert_eq!(requests, vec![(-1, 0), (0, -1), (0, 1)]);
        for _ in 0..3 {
            s.tick();
            assert!(s.take_generation_requests().is_empty());
            assert_eq!(s.generating.len(), 3);
        }
        s.generate_now(-1, 0);
        assert!(!s.generating.contains(&(-1, 0)));
        s.tick();
        assert_eq!(s.take_generation_requests(), vec![(1, 0)]);
        assert_eq!(s.generating.len(), 3);
    }

    #[test]
    fn external_delivery_fallback_and_chunk_state_match_local_generation() {
        for generator in [Generator::Flat, Generator::DebugHills, Generator::Terrain] {
            let mut s = Server::new(2026, generator);
            s.set_external_generation(1);
            assert!(!s.ensure_chunk((-2, 3)));
            let expected = worldgen::generate(generator, 2026, -2, 3);
            assert!(!s.deliver_generated(-2, 3, &[1, 2, 3]));
            assert_eq!(s.world.chunks[&(-2, 3)], expected);
            assert!(s.generating.is_empty());
            assert!(s.take_generation_requests().is_empty());
            assert_eq!(s.stats.chunks_generated, 1);
            assert_eq!(s.stats.chunks_generated_externally, 0);
            assert!(!s.deliver_generated(-2, 3, &expected.to_bytes()));
            assert_eq!(s.stats.chunks_generated, 1);

            assert!(!s.ensure_chunk((4, -5)));
            let expected = worldgen::generate(generator, 2026, 4, -5);
            assert!(s.deliver_generated(4, -5, &expected.to_bytes()));
            assert_eq!(s.world.chunks[&(4, -5)], expected);
            assert_eq!(s.stats.chunks_generated_externally, 1);
            assert!(s.take_dirty().is_none());

            assert!(!s.ensure_chunk((6, 7)));
            s.generate_now(6, 7);
            assert!(s.generating.is_empty());
            assert!(s.take_generation_requests().is_empty());
            assert_eq!(
                s.world.chunks[&(6, 7)],
                worldgen::generate(generator, 2026, 6, 7)
            );
        }
    }

    #[test]
    fn disabling_external_generation_resumes_synchronous_generation() {
        let mut s = Server::new(1, Generator::Flat);
        s.set_external_generation(1);
        assert!(!s.ensure_chunk((0, 0)));
        s.set_external_generation(0);
        assert!(s.ensure_chunk((0, 0)));
        assert!(s.generating.is_empty());
        assert!(s.take_generation_requests().is_empty());
        assert!(s.ensure_chunk((1, 0)));
        assert_eq!(s.stats.chunks_generated, 2);
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
