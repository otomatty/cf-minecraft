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

pub mod entity;
pub mod furnace;
mod health;
pub mod inventory;
pub mod mob;
mod random_ticks;
pub mod scenario;
mod water;
use inventory::{Inventory, Stack};
pub use random_ticks::RANDOM_TICKS_PER_SECTION;
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum GameMode {
    #[default]
    Creative = 0,
    Survival = 1,
}

use std::collections::{BTreeMap, BTreeSet};

use protocol::{C2S, MAX_FURNACE_DISPLAY_TICKS, S2C};
use world::io::Reader;
use world::{blocks, items, Chunk, Fnv64, World, HEIGHT, MIN_Y};
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
// Prediction's jump rises about 1.25 blocks. Leave room for rounding.
const MAX_SURVIVAL_RISE: f64 = 1.5;
const AIRBORNE_GRACE_TICKS: i64 = 20;
const MIN_AIRBORNE_DESCENT: f64 = 0.05;

type ChunkPos = (i32, i32);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Dig {
    pos: [i32; 3],
    state: u16,
    start: i64,
    ticks: u32,
    drops: bool,
    stage: Option<u8>,
}

#[derive(Clone, Copy, Default)]
struct SurvivalMovement {
    jump_base_y: Option<f64>,
    airborne_progress: Option<(i64, f64)>,
}

impl SurvivalMovement {
    fn advance(self, world: &World, from: [f64; 3], to: [f64; 3], tick: i64) -> Option<Self> {
        let y = to[1];
        let blocks = physics::BlockWorld(|x, y, z| world.get_block(x, y, z));
        if physics::in_water(&blocks, to) {
            return Some(Self {
                jump_base_y: Some(y),
                airborne_progress: None,
            });
        }
        let from_water = physics::in_water(&blocks, from);
        let jump_base_y = if from_water || health::grounded(world, from) {
            Some(from[1])
        } else {
            self.jump_base_y
        };
        // The Y sweep can land before the horizontal sweep moves off the edge.
        let grounded = health::grounded(world, to)
            || (y <= from[1] && health::grounded(world, [from[0], y, from[2]]));
        if y > from[1]
            && !(grounded && y - from[1] <= physics::STEP_HEIGHT
                || jump_base_y.is_some_and(|base| y <= base + MAX_SURVIVAL_RISE))
        {
            return None;
        }
        let airborne_progress = if grounded {
            None
        } else if let Some((last_tick, height)) = self.airborne_progress.filter(|_| !from_water) {
            if y <= height - MIN_AIRBORNE_DESCENT {
                Some((tick, y))
            } else if tick - last_tick >= AIRBORNE_GRACE_TICKS && y > from[1] - MIN_AIRBORNE_DESCENT
            {
                return None;
            } else {
                self.airborne_progress
            }
        } else {
            Some((tick, from[1].min(y)))
        };
        Some(Self {
            jump_base_y: if grounded {
                Some(y)
            } else {
                jump_base_y.filter(|&base| y >= base)
            },
            airborne_progress,
        })
    }

    fn hash_into(self, h: &mut Fnv64) {
        health::hash_height(h, self.jump_base_y);
        health::hash_height(h, self.airborne_progress.map(|(_, y)| y));
        if let Some((tick, _)) = self.airborne_progress {
            h.i64(tick);
        }
    }
}

struct Client {
    dig: Option<Dig>,
    visible_entities: BTreeMap<u32, ([f64; 3], u8)>,
    visible_mobs: BTreeMap<u32, ([f64; 3], f32)>,
    inventory: Inventory,
    health: health::Health,
    survival_movement: SurvivalMovement,
    inventory_dirty: bool,
    joined: bool,
    view: i32,
    pos: [f64; 3],
    yaw: f32,
    sent: BTreeSet<ChunkPos>,
    allow_teleport: bool,
    accepted_tick: i64,
    budget_tick: i64,
    horizontal_budget: f64,
    vertical_budget: f64,
    correction_tick: Option<i64>,
}

impl Client {
    fn relocate(&mut self, pos: [f64; 3], tick: i64) {
        self.pos = pos;
        self.accepted_tick = tick;
        self.budget_tick = tick;
        self.horizontal_budget = HORIZONTAL_PER_TICK * MOVEMENT_RESERVE;
        self.vertical_budget = VERTICAL_PER_TICK * MOVEMENT_RESERVE;
        self.correction_tick = None;
        self.health.fall_start_y = Some(pos[1]);
        self.survival_movement = SurvivalMovement::default();
    }

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

fn players_keep_chunk(clients: &BTreeMap<u32, Client>, cx: i32, cz: i32) -> bool {
    clients.values().any(|c| {
        let (px, pz) = c.center();
        let r = c.view + UNLOAD_MARGIN;
        (cx - px).abs() <= r && (cz - pz).abs() <= r
    })
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

struct SavedChunk {
    chunk: Chunk,
    furnaces: BTreeMap<[i32; 3], furnace::Furnace>,
    scheduled_blocks: Vec<(u16, [i32; 3])>,
}

pub struct Server {
    scheduled_blocks: BTreeSet<(i64, [i32; 3])>,
    scheduled_block_times: BTreeMap<[i32; 3], i64>,
    furnaces: BTreeMap<[i32; 3], furnace::Furnace>,
    entities: BTreeMap<u32, entity::Entity>,
    mobs: BTreeMap<u32, mob::Mob>,
    next_entity_id: u32,
    game_mode: GameMode,
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
    dig_updates: BTreeMap<(u32, [i32; 3]), u8>,
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
            scheduled_blocks: BTreeSet::new(),
            scheduled_block_times: BTreeMap::new(),
            furnaces: BTreeMap::new(),
            entities: BTreeMap::new(),
            mobs: BTreeMap::new(),
            next_entity_id: 1,
            game_mode: GameMode::Creative,
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
            dig_updates: BTreeMap::new(),
            stored: BTreeSet::new(),
            requested: BTreeSet::new(),
            requests: Vec::new(),
            max_generation_in_flight: 0,
            generating: BTreeSet::new(),
            generation_requests: Vec::new(),
            stats: Stats::default(),
        }
    }

    pub fn set_game_mode(&mut self, mode: GameMode) {
        self.game_mode = mode;
    }
    pub fn inventory_data(&self, id: u32) -> Option<Vec<u8>> {
        self.clients
            .get(&id)
            .map(|c| c.inventory.to_bytes(c.health.vitals))
    }

    fn send_inventory(&mut self, id: u32) {
        let client = self.clients.get_mut(&id).expect("client");
        client.inventory_dirty = false;
        let f = if let inventory::Screen::Furnace { pos } = client.inventory.screen {
            self.furnaces.get(&pos).cloned().unwrap_or_default()
        } else {
            furnace::Furnace::default()
        };
        self.outbox.push((
            id,
            S2C::Inventory {
                furnace: f.slots.map(|s| s.map(|s| (s.item, s.count))),
                burn: f.burn.min(u32::from(MAX_FURNACE_DISPLAY_TICKS)) as u16,
                total: f.total.min(u32::from(MAX_FURNACE_DISPLAY_TICKS)) as u16,
                progress: f.progress,
                screen: match client.inventory.screen {
                    inventory::Screen::None => 0,
                    inventory::Screen::CraftingTable { .. } => 1,
                    inventory::Screen::Furnace { .. } => 2,
                },
                table: client.inventory.table.map(|s| s.map(|s| (s.item, s.count))),
                crafting: client
                    .inventory
                    .crafting
                    .map(|s| s.map(|s| (s.item, s.count))),
                result: client.inventory.result().map(|s| (s.item, s.count)),
                cursor: client.inventory.cursor.map(|s| (s.item, s.count)),
                selected: client.inventory.selected(),
                slots: client
                    .inventory
                    .slots()
                    .iter()
                    .map(|s| s.map(|s| (s.item, s.count)))
                    .collect(),
            }
            .encode(),
        ));
    }

    pub fn entities(&self) -> &BTreeMap<u32, entity::Entity> {
        &self.entities
    }

    fn allocate_entity_id(&mut self) -> Option<u32> {
        // Exhaustion never reuses an ID.
        let id = self.next_entity_id;
        if id == 0 {
            return None;
        }
        self.next_entity_id = id.checked_add(1).unwrap_or(0);
        Some(id)
    }

    fn spawn_item(
        &mut self,
        item: u16,
        count: u8,
        pos: [f64; 3],
        velocity: [f64; 3],
        pickup_delay: u32,
    ) {
        let Some(id) = self.allocate_entity_id() else {
            return;
        };
        if self.entities.len() >= 1024 {
            self.entities.pop_first();
        }
        self.entities.insert(
            id,
            entity::Entity {
                kind: entity::EntityKind::Item,
                pos,
                velocity,
                item,
                count,
                age: 0,
                pickup_delay,
                on_ground: false,
            },
        );
    }
    fn tick_entities(&mut self) {
        let held: Vec<_> = self
            .clients
            .iter()
            .filter(|(_, c)| c.dig.is_some())
            .map(|(&id, c)| {
                (
                    id,
                    (
                        c.inventory.selected(),
                        c.inventory.selected_stack().map(|stack| stack.item),
                    ),
                )
            })
            .collect();
        self.entities
            .extract_if(.., |_, e| {
                let previous = e.pos;
                if self.world.chunks.contains_key(&e.chunk()) {
                    e.tick(&self.world);
                }
                let active = e.age < 6000 && e.pos[1] >= health::VOID_Y;
                !active || crosses_lava(&self.world, previous, e.pos)
            })
            .for_each(drop);
        if (self.game_time + 1) % 10 == 0 {
            self.merge_entities();
        }
        for e in self.entities.values_mut() {
            if e.pickup_delay != 0 || !self.world.chunks.contains_key(&e.chunk()) {
                continue;
            }
            for c in self
                .clients
                .values_mut()
                .filter(|c| c.joined && !c.health.vitals.dead)
            {
                let mut bounds = physics::Player::new(c.pos).bounds();
                for (a, amount) in [1.0, 0.5, 1.0].into_iter().enumerate() {
                    bounds.min[a] -= amount;
                    bounds.max[a] += amount;
                }
                if bounds.intersects(e.bounds()) {
                    let remaining = c.inventory.add(e.item, e.count as u32) as u8;
                    c.inventory_dirty |= remaining != e.count;
                    e.count = remaining;
                    if remaining == 0 {
                        break;
                    }
                }
            }
        }
        self.entities.retain(|_, e| e.count != 0);
        for (id, before) in held {
            if before
                != (
                    self.clients[&id].inventory.selected(),
                    self.clients[&id]
                        .inventory
                        .selected_stack()
                        .map(|stack| stack.item),
                )
            {
                self.abort_dig(id);
            }
        }
    }
    /// Returns the number of candidate pairs compared, also used by budget tests.
    fn merge_entities(&mut self) -> usize {
        const MAX_COMPARISONS: usize = 4096;
        let mut grid: BTreeMap<(u16, i32, i32, i32), Vec<u32>> = BTreeMap::new();
        for (&id, e) in &self.entities {
            if e.count == items::info(e.item).unwrap().max_stack
                || !self.world.chunks.contains_key(&e.chunk())
            {
                continue;
            }
            let [x, y, z] = e.pos.map(|v| v.floor() as i32);
            grid.entry((e.item, x, y, z)).or_default().push(id);
        }
        let ids: Vec<_> = self.entities.keys().copied().collect();
        let mut comparisons = 0;
        for id in ids {
            let Some(a) = self.entities.get(&id) else {
                continue;
            };
            let max_stack = items::info(a.item).unwrap().max_stack;
            if a.count == max_stack || !self.world.chunks.contains_key(&a.chunk()) {
                continue;
            }
            let [x, y, z] = a.pos.map(|v| v.floor() as i32);
            // Merge sorted bucket iterators without copying every nearby ID.
            // The queue holds at most one next candidate per neighboring cell.
            let mut candidates = BTreeMap::new();
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        if let Some(bucket) = grid.get(&(a.item, x + dx, y + dy, z + dz)) {
                            let start = bucket.partition_point(|&other| other <= id);
                            let mut rest = bucket[start..].iter();
                            if let Some(&first) = rest.next() {
                                candidates.insert(first, rest);
                            }
                        }
                    }
                }
            }
            while let Some((other, mut rest)) = candidates.pop_first() {
                if let Some(&next) = rest.next() {
                    candidates.insert(next, rest);
                }
                let a = &self.entities[&id];
                if a.count == max_stack {
                    break;
                }
                let Some(b) = self.entities.get(&other) else {
                    continue;
                };
                if b.count == max_stack {
                    continue;
                }
                if comparisons == MAX_COMPARISONS {
                    return comparisons;
                }
                comparisons += 1;
                if (0..3).all(|axis| (a.pos[axis] - b.pos[axis]).abs() <= 0.5)
                    && a.count as u16 + b.count as u16 <= max_stack as u16
                {
                    let b = self.entities.remove(&other).unwrap();
                    let a = self.entities.get_mut(&id).unwrap();
                    a.count += b.count;
                    a.age = a.age.max(b.age);
                    a.pickup_delay = a.pickup_delay.max(b.pickup_delay);
                }
            }
        }
        comparisons
    }

    fn sync_entities(&mut self) {
        for (&client_id, c) in &mut self.clients {
            if !c.joined {
                continue;
            }
            let visible: BTreeMap<_, _> = self
                .entities
                .iter()
                .filter(|(_, e)| c.sent.contains(&e.chunk()))
                .map(|(&id, e)| (id, (e.pos, e.count)))
                .collect();
            for &id in c
                .visible_entities
                .keys()
                .filter(|id| !visible.contains_key(id))
            {
                self.outbox
                    .push((client_id, S2C::EntityRemove { id }.encode()));
            }
            for (&id, &(pos, count)) in &visible {
                let [x, y, z] = pos;
                if let Some(&(old_pos, old_count)) = c.visible_entities.get(&id) {
                    if old_pos != pos {
                        self.outbox
                            .push((client_id, S2C::EntityMove { id, x, y, z }.encode()));
                    }
                    if old_count != count {
                        self.outbox
                            .push((client_id, S2C::EntityCount { id, count }.encode()));
                    }
                } else {
                    let e = &self.entities[&id];
                    self.outbox.push((
                        client_id,
                        S2C::EntitySpawn {
                            id,
                            kind: e.kind as u8,
                            item: e.item,
                            count,
                            x,
                            y,
                            z,
                        }
                        .encode(),
                    ));
                }
            }
            c.visible_entities = visible;
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
        self.connect_at(id, allow_teleport, None, None);
    }

    /// Restore a trusted host's last accepted feet position on reconnect.
    /// Invalid coordinates fall back to spawn; no chunk load is required here.
    pub fn connect_at(
        &mut self,
        id: u32,
        allow_teleport: bool,
        position: Option<[f64; 3]>,
        inventory: Option<&[u8]>,
    ) {
        let pos = position
            .filter(|p| valid_position(*p))
            .unwrap_or_else(|| self.spawn());
        let (inventory, vitals) = inventory
            .and_then(|bytes| Inventory::from_bytes(bytes).ok())
            .unwrap_or_else(|| {
                let inventory = match self.game_mode {
                    GameMode::Creative => Inventory::creative(),
                    GameMode::Survival => Inventory::default(),
                };
                (inventory, protocol::PlayerVitals::default())
            });
        self.clients.insert(
            id,
            Client {
                dig: None,
                visible_entities: BTreeMap::new(),
                visible_mobs: BTreeMap::new(),
                inventory,
                health: health::Health::new(vitals, pos[1]),
                survival_movement: SurvivalMovement::default(),
                inventory_dirty: false,
                joined: false,
                view: DEFAULT_VIEW_DISTANCE,
                pos,
                yaw: 0.0,
                sent: BTreeSet::new(),
                allow_teleport,
                accepted_tick: self.game_time,
                budget_tick: self.game_time,
                horizontal_budget: HORIZONTAL_PER_TICK * MOVEMENT_RESERVE,
                vertical_budget: VERTICAL_PER_TICK * MOVEMENT_RESERVE,
                correction_tick: None,
            },
        );
        self.return_crafting(id);
    }

    /// Last accepted position, never a queued or rejected client report.
    pub fn client_position(&self, id: u32) -> Option<[f64; 3]> {
        self.clients.get(&id).map(|client| client.pos)
    }

    pub fn return_crafting(&mut self, id: u32) {
        let Some(client) = self.clients.get_mut(&id) else {
            return;
        };
        let had_transient = client.inventory.cursor.is_some()
            || client.inventory.crafting.iter().any(Option::is_some)
            || client.inventory.table.iter().any(Option::is_some)
            || client.inventory.screen != inventory::Screen::None;
        let overflow = client.inventory.return_crafting();
        client.inventory_dirty |= had_transient;
        let pos = client.pos;
        self.drop_carried_stacks(overflow, pos);
    }

    fn drop_carried_stacks(&mut self, stacks: impl IntoIterator<Item = Stack>, pos: [f64; 3]) {
        for stack in stacks {
            self.spawn_item(stack.item, stack.count, pos, [0.0, 0.1, 0.0], 40);
        }
    }
    pub fn disconnect(&mut self, id: u32) {
        self.return_crafting(id);
        self.abort_dig(id);
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
            Err(_) => {
                self.stats.packets_rejected += 1;
                if matches!(
                    bytes.first(),
                    Some(
                        &protocol::id::C2S_CREATIVE_SET_SLOT
                            | &protocol::id::C2S_CLICK_SLOT
                            | &protocol::id::C2S_USE_BLOCK
                    )
                ) {
                    self.clients.get_mut(&id).unwrap().inventory_dirty = true;
                }
            }
        }
    }

    pub fn tick(&mut self) {
        // Expire immunity before processing attacks, so a new hit keeps all ten ticks.
        for mob in self.mobs.values_mut() {
            mob.hurt_ticks = mob.hurt_ticks.saturating_sub(1);
        }
        let pending = std::mem::take(&mut self.pending);
        for (id, packet) in pending {
            self.apply(id, packet);
        }
        self.tick_digs();
        self.stream_chunks();
        self.tick_entities();

        self.game_time += 1;
        self.day_time += 1;
        self.tick_mobs();
        self.tick_health();
        self.tick_screens();
        self.flush_digs();
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
        self.tick_furnaces();
        self.tick_random_blocks();
        self.tick_scheduled_blocks();
        // Natural block changes can interrupt digs after the regular flush.
        self.flush_digs();
        self.sync_entities();
        self.sync_mobs();
        let changed: Vec<_> = self
            .clients
            .iter()
            .filter(|(_, c)| c.joined && c.inventory_dirty)
            .map(|(&id, _)| id)
            .collect();
        for id in changed {
            self.send_inventory(id);
        }
    }

    fn apply(&mut self, id: u32, packet: C2S) {
        if self.clients[&id].health.vitals.dead
            && !matches!(
                packet,
                C2S::Hello { .. } | C2S::Respawn | C2S::UseBucket { .. } | C2S::Attack { .. }
            )
        {
            self.stats.packets_rejected += 1;
            return;
        }
        let before = (
            self.clients[&id].inventory.selected(),
            self.clients[&id]
                .inventory
                .selected_stack()
                .map(|stack| stack.item),
        );
        self.apply_packet(id, packet);
        let after = (
            self.clients[&id].inventory.selected(),
            self.clients[&id]
                .inventory
                .selected_stack()
                .map(|stack| stack.item),
        );
        if before != after {
            self.abort_dig(id);
        }
    }

    fn apply_packet(&mut self, id: u32, packet: C2S) {
        match packet {
            C2S::Respawn => self.respawn(id),
            C2S::UseItem => self.use_item(id),
            C2S::StopUsingItem => self.stop_using_item(id),
            C2S::Attack { id: target } => self.attack(id, target),
            C2S::DigAbort => {
                if self.game_mode != GameMode::Survival || !self.clients[&id].joined {
                    self.stats.packets_rejected += 1;
                } else {
                    self.abort_dig(id);
                }
            }
            C2S::DigStart { x, y, z } => {
                if self.game_mode != GameMode::Survival {
                    self.stats.packets_rejected += 1;
                    return;
                }
                self.abort_dig(id);
                let state = self.world.get_block(x, y, z);
                let mining = state.and_then(|s| {
                    items::mining(
                        s,
                        self.clients[&id]
                            .inventory
                            .selected_stack()
                            .map(|stack| stack.item),
                    )
                });
                if !self.can_edit(id, x, y, z, blocks::AIR) || mining.is_none() {
                    self.stats.packets_rejected += 1;
                    self.correct_block(id, x, y, z);
                    return;
                }
                let (ticks, drops) = mining.unwrap();
                if ticks == 0 {
                    self.change_block(id, [x, y, z], blocks::AIR, drops);
                    self.add_mining_exhaustion(id);
                    self.dig_updates.insert((id, [x, y, z]), 255);
                    return;
                }
                self.clients.get_mut(&id).unwrap().dig = Some(Dig {
                    pos: [x, y, z],
                    state: state.unwrap(),
                    start: self.game_time,
                    ticks,
                    drops,
                    stage: None,
                });
            }

            C2S::ClickSlot {
                slot,
                button,
                shift,
            } => {
                let client = &self.clients[&id];
                if !client.joined {
                    self.stats.packets_rejected += 1;
                    return;
                }
                if !self.table_screen_valid(client) {
                    self.return_crafting(id);
                    self.stats.packets_rejected += 1;
                    return;
                }
                let client = self.clients.get_mut(&id).unwrap();
                let result = if let inventory::Screen::Furnace { pos } = client.inventory.screen {
                    let f = self.furnaces.entry(pos).or_default();
                    let before = f.clone();
                    let result = client.inventory.click_furnace(f, slot, button, shift);
                    if *f != before {
                        self.furnace_changed(pos);
                    }
                    result
                } else {
                    client.inventory.click(slot, button, shift)
                };
                if result.is_err() {
                    self.stats.packets_rejected += 1;
                }
                self.clients.get_mut(&id).unwrap().inventory_dirty = true;
                self.abort_dig(id);
            }
            C2S::UseBucket { x, y, z } => self.use_bucket(id, [x, y, z]),
            C2S::UseBlock { x, y, z } => {
                let client = &self.clients[&id];
                let pos = [x, y, z];
                let allowed = client.joined
                    && client.inventory.screen == inventory::Screen::None
                    && self.within_reach(client.pos, pos);
                let target = allowed.then(|| self.world.get_block(x, y, z)).flatten();
                let held_tool = client
                    .inventory
                    .selected_stack()
                    .and_then(|stack| items::info(stack.item))
                    .and_then(|item| item.tool);
                let client = self.clients.get_mut(&id).unwrap();
                client.inventory_dirty = true;
                match target {
                    Some(blocks::FURNACE) => {
                        self.furnaces.entry(pos).or_default();
                        client.inventory.screen = inventory::Screen::Furnace { pos };
                    }
                    Some(blocks::CRAFTING_TABLE) => {
                        client.inventory.screen = inventory::Screen::CraftingTable { pos };
                    }
                    Some(blocks::GRASS_BLOCK | blocks::DIRT)
                        if held_tool.is_some_and(|tool| tool.kind == items::ToolKind::Hoe)
                            && self.world.get_block(x, y + 1, z) == Some(blocks::AIR) =>
                    {
                        self.change_block_naturally(pos, blocks::FARMLAND);
                    }
                    _ => self.stats.packets_rejected += 1,
                }
            }
            C2S::CloseInventory => {
                self.return_crafting(id);
            }
            C2S::DropItem { dir } => {
                let client = self.clients.get_mut(&id).unwrap();
                if !client.joined || !dir.iter().all(|v| v.is_finite()) {
                    self.stats.packets_rejected += 1;
                    return;
                }
                if self.next_entity_id == 0 {
                    return;
                }
                let Some(item) = client.inventory.take_selected() else {
                    return;
                };
                client.inventory_dirty = true;
                let mut pos = client.pos;
                pos[1] += 1.3;
                let mut velocity = dir.map(f64::from);
                let length = (velocity[0] * velocity[0]
                    + velocity[1] * velocity[1]
                    + velocity[2] * velocity[2])
                    .sqrt();
                for v in &mut velocity {
                    *v = *v / length.max(1.0) * 0.3;
                }
                velocity[1] += 0.1;
                self.spawn_item(item, 1, pos, velocity, 40);
            }
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
                    game_mode: self.game_mode as u8,
                };
                self.outbox.push((id, welcome.encode()));
                self.send_inventory(id);
            }
            C2S::SelectSlot { slot } => {
                let client = self.clients.get_mut(&id).unwrap();
                let before = client.inventory.selected();
                if !client.joined || client.inventory.select(slot).is_err() {
                    self.stats.packets_rejected += 1;
                } else {
                    client.inventory_dirty |= before != client.inventory.selected();
                }
            }
            C2S::CreativeSetSlot { slot, item, count } => {
                let client = self.clients.get_mut(&id).unwrap();
                let before = client.inventory.clone();
                let stack = (item != 0).then_some(Stack { item, count });
                if !client.joined
                    || self.game_mode != GameMode::Creative
                    || client.inventory.set(slot, stack).is_err()
                {
                    self.stats.packets_rejected += 1;
                    client.inventory_dirty = true;
                }
                client.inventory_dirty |= before != client.inventory;
            }
            C2S::PlayerPos { x, y, z, yaw, .. } => {
                self.move_player(id, [x, y, z], Some(yaw));
            }
            C2S::Teleport { x, y, z } => {
                self.move_player(id, [x, y, z], None);
            }
            C2S::SetBlock { x, y, z, state } => {
                let old = self.world.get_block(x, y, z);
                let survival_ok = self.game_mode == GameMode::Creative
                    || if state == blocks::AIR {
                        false
                    } else {
                        old.is_some_and(|old| {
                            matches!(old, blocks::AIR | blocks::SHORT_GRASS)
                                || blocks::is_water(old)
                                || blocks::info(old).name == blocks::info(state).name
                        }) && self.clients[&id]
                            .inventory
                            .selected_stack()
                            .and_then(|stack| items::info(stack.item))
                            .and_then(|item| item.block)
                            .is_some_and(|block| {
                                blocks::info(block).name == blocks::info(state).name
                            })
                    };
                if !self.can_edit(id, x, y, z, state) || !survival_ok {
                    self.stats.packets_rejected += 1;
                    self.correct_block(id, x, y, z);
                    return;
                }
                self.change_block(id, [x, y, z], state, true);
            }
        }
    }

    fn change_block(&mut self, id: u32, [x, y, z]: [i32; 3], state: u16, drops: bool) {
        if let Some(old) = self.world.set_block(x, y, z, state) {
            if old != state {
                if old == blocks::FURNACE {
                    if let Some(f) = self.furnaces.remove(&[x, y, z]) {
                        for stack in f.slots.into_iter().flatten() {
                            self.spawn_item(
                                stack.item,
                                stack.count,
                                [x as f64 + 0.5, y as f64 + 0.25, z as f64 + 0.5],
                                [0.0, 0.1, 0.0],
                                10,
                            );
                        }
                    }
                }
                if state == blocks::FURNACE {
                    self.furnaces.insert([x, y, z], furnace::Furnace::default());
                }

                self.abort_digs_at([x, y, z]);
                if self.game_mode == GameMode::Survival {
                    if state == blocks::AIR {
                        if drops {
                            self.spawn_mining_drops([x, y, z], old);
                        }
                    } else {
                        let client = self.clients.get_mut(&id).unwrap();
                        client.inventory.take_selected();
                        client.inventory_dirty = true;
                    }
                }
                self.stats.blocks_changed += 1;
                self.broadcast_block(x, y, z, state);
                self.schedule_fluid_neighbors([x, y, z]);
                self.check_wheat_above([x, y, z], state);
            }
        }
    }

    fn block_drop_random(&self, pos: [i32; 3]) -> jmath::JavaRandom {
        let mut hash = Fnv64::new();
        hash.bytes(&self.seed.to_be_bytes());
        hash.bytes(&self.game_time.to_be_bytes());
        for axis in pos {
            hash.bytes(&axis.to_be_bytes());
        }
        jmath::JavaRandom::new(jmath::mix_stafford13(hash.finish()) as i64)
    }

    fn spawn_mining_drops(&mut self, pos: [i32; 3], state: u16) {
        if state == blocks::SHORT_GRASS {
            if self.block_drop_random(pos).next_int_bound(8) == 0 {
                self.spawn_block_drop(items::by_name("wheat_seeds").unwrap(), 1, pos, 0.25);
            }
        } else if let Some(mut item) = items::mining_drop(state) {
            let count = if state == blocks::RIPE_WHEAT {
                self.spawn_block_drop(items::by_name("wheat").unwrap(), 1, pos, 0.25);
                1 + self.block_drop_random(pos).next_int_bound(2) as u8
            } else {
                if state == blocks::OAK_LEAVES && self.leaf_drops_apple() {
                    item = items::by_name("apple").unwrap();
                }
                1
            };
            self.spawn_block_drop(item, count, pos, 0.25);
        }
    }

    fn leaf_drops_apple(&self) -> bool {
        let mut roll =
            jmath::JavaRandom::new(self.seed ^ 0x0061_7070_6c65 ^ self.next_entity_id as i64);
        roll.next_int_bound(10) == 0
    }

    fn spawn_block_drop(&mut self, item: u16, count: u8, [x, y, z]: [i32; 3], height: f64) {
        let mut random = jmath::JavaRandom::new(self.seed.wrapping_add(self.next_entity_id as i64));
        let velocity = [
            random.next_double() * 0.1 - 0.05,
            0.1,
            random.next_double() * 0.1 - 0.05,
        ];
        self.spawn_item(
            item,
            count,
            [x as f64 + 0.5, y as f64 + height, z as f64 + 0.5],
            velocity,
            10,
        );
    }

    fn abort_digs_at(&mut self, pos: [i32; 3]) {
        let miners: Vec<_> = self
            .clients
            .iter()
            .filter(|(_, c)| c.dig.is_some_and(|dig| dig.pos == pos))
            .map(|(&id, _)| id)
            .collect();
        for miner in miners {
            self.abort_dig(miner);
        }
    }

    fn abort_dig(&mut self, id: u32) {
        if let Some(dig) = self.clients.get_mut(&id).and_then(|c| c.dig.take()) {
            self.dig_updates.insert((id, dig.pos), 255);
        }
    }

    fn attack(&mut self, attacker: u32, id: u32) {
        let client = self.clients.get_mut(&attacker).unwrap();
        if !client.joined || client.health.vitals.dead {
            return;
        }
        let Some(mob) = self.mobs.get_mut(&id) else {
            return;
        };
        if mob.hurt_ticks != 0 || !mob.within_attack_reach(client.pos) {
            return;
        }

        let tool = client
            .inventory
            .selected_stack()
            .and_then(|stack| items::info(stack.item)?.tool);
        let damage = tool.map_or(1, |tool| {
            tool.tier
                + match tool.kind {
                    items::ToolKind::Axe => 2,
                    items::ToolKind::Pickaxe => 1,
                    items::ToolKind::Shovel | items::ToolKind::Hoe => 0,
                }
        });
        mob.hurt(
            &self.world,
            damage,
            (client.pos, client.yaw),
            self.seed,
            id,
            self.game_time,
        );
        if self.game_mode == GameMode::Survival {
            client.health.add_exhaustion(40);
        }
        if mob.health == 0 {
            let mob = self.mobs.remove(&id).unwrap();
            self.drop_mob_loot(id, mob, false);
        } else {
            self.send_mob_hurt(id);
        }
    }

    fn send_mob_hurt(&mut self, id: u32) {
        let packet = S2C::MobHurt { id }.encode();
        for (&viewer, client) in &self.clients {
            if client.visible_mobs.contains_key(&id) {
                self.outbox.push((viewer, packet.clone()));
            }
        }
    }

    fn add_mining_exhaustion(&mut self, id: u32) {
        let health = &mut self.clients.get_mut(&id).unwrap().health;
        if self.game_mode == GameMode::Survival && !health.vitals.dead {
            health.add_exhaustion(20);
        }
    }

    fn tick_digs(&mut self) {
        let digs: Vec<_> = self
            .clients
            .iter()
            .filter_map(|(&id, c)| c.dig.map(|d| (id, d)))
            .collect();
        for (id, dig) in digs {
            let [x, y, z] = dig.pos;
            if self.world.get_block(x, y, z) != Some(dig.state)
                || !self.can_edit(id, x, y, z, blocks::AIR)
            {
                self.abort_dig(id);
                continue;
            }
            let elapsed = self.game_time - dig.start;
            if elapsed >= i64::from(dig.ticks) {
                self.change_block(id, [x, y, z], blocks::AIR, dig.drops);
                self.add_mining_exhaustion(id);
                self.abort_dig(id);
            } else {
                let stage = ((elapsed * 10 / i64::from(dig.ticks)).min(9)) as u8;
                if dig.stage != Some(stage) {
                    self.clients
                        .get_mut(&id)
                        .unwrap()
                        .dig
                        .as_mut()
                        .unwrap()
                        .stage = Some(stage);
                    self.dig_updates.insert((id, dig.pos), stage);
                }
            }
        }
    }

    fn flush_digs(&mut self) {
        for ((player, [x, y, z]), stage) in std::mem::take(&mut self.dig_updates) {
            let bytes = S2C::DigProgress {
                player,
                x,
                y,
                z,
                stage,
            }
            .encode();
            for (&id, c) in &self.clients {
                if id != player && c.joined && c.sent.contains(&(x >> 4, z >> 4)) {
                    self.outbox.push((id, bytes.clone()));
                }
            }
        }
    }

    fn respawn(&mut self, id: u32) {
        let spawn = self.spawn();
        let client = self.clients.get_mut(&id).unwrap();
        if !client.joined || !client.health.vitals.dead {
            self.stats.packets_rejected += 1;
            return;
        }
        let last_sent = client.health.last_sent;
        client.health = health::Health::new(protocol::PlayerVitals::default(), spawn[1]);
        client.health.last_sent = last_sent;
        client.relocate(spawn, self.game_time);
        self.correct_position(id);
    }

    fn correct_position(&mut self, id: u32) {
        let [x, y, z] = self.clients[&id].pos;
        self.outbox
            .push((id, S2C::PlayerCorrect { x, y, z }.encode()));
    }

    fn move_player(&mut self, id: u32, pos: [f64; 3], yaw: Option<f32>) {
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
        let survival = self.game_mode == GameMode::Survival;
        if finite && yaw.is_none() && client.allow_teleport {
            client.relocate(pos, self.game_time);
            return;
        }
        if let Some(yaw) = yaw.filter(|_| {
            finite && horizontal <= client.horizontal_budget && vertical <= client.vertical_budget
        }) {
            let movement = if survival {
                client
                    .survival_movement
                    .advance(&self.world, client.pos, pos, self.game_time)
            } else {
                Some(client.survival_movement)
            };
            if let Some(movement) =
                movement.filter(|_| movement_clear(&self.world, client.pos, pos))
            {
                let prev = client.pos;
                client.pos = pos;
                if yaw.is_finite() {
                    client.yaw = yaw;
                }
                client.accepted_tick = self.game_time;
                client.horizontal_budget -= horizontal;
                client.vertical_budget -= vertical;
                client.survival_movement = movement;
                if survival {
                    client.health.observe_fall(&self.world, prev, pos);
                    client.health.walk(horizontal);
                }
                return;
            }
        }

        self.stats.packets_rejected += 1;
        self.stats.positions_rejected += 1;
        if client.correction_tick != Some(self.game_time) {
            client.correction_tick = Some(self.game_time);
            self.correct_position(id);
        }
    }

    fn within_reach(&self, player: [f64; 3], [x, y, z]: [i32; 3]) -> bool {
        let dx = x as f64 + 0.5 - player[0];
        let dy = y as f64 + 0.5 - player[1];
        let dz = z as f64 + 0.5 - player[2];
        dx * dx + dy * dy + dz * dz <= MAX_REACH * MAX_REACH
    }

    fn table_screen_valid(&self, client: &Client) -> bool {
        match client.inventory.screen {
            inventory::Screen::None => true,
            inventory::Screen::Furnace { pos: [x, y, z] } => {
                self.world.get_block(x, y, z) == Some(blocks::FURNACE)
                    && self.within_reach(client.pos, [x, y, z])
            }
            inventory::Screen::CraftingTable { pos: [x, y, z] } => {
                self.world.get_block(x, y, z) == Some(blocks::CRAFTING_TABLE)
                    && self.within_reach(client.pos, [x, y, z])
            }
        }
    }

    fn furnace_changed(&mut self, pos: [i32; 3]) {
        if let Some(c) = self.world.chunks.get_mut(&(pos[0] >> 4, pos[2] >> 4)) {
            c.dirty = true;
        }
        for c in self.clients.values_mut() {
            if c.inventory.screen == (inventory::Screen::Furnace { pos }) {
                c.inventory_dirty = true;
            }
        }
    }
    fn tick_furnaces(&mut self) {
        let mut changed = Vec::new();
        let clients = &self.clients;
        for (&pos, f) in &mut self.furnaces {
            if !players_keep_chunk(clients, pos[0] >> 4, pos[2] >> 4) {
                continue;
            }
            let before = f.clone();
            f.tick();
            if *f != before {
                changed.push(pos);
            }
        }
        for pos in changed {
            self.furnace_changed(pos);
        }
    }
    fn tick_screens(&mut self) {
        let close: Vec<_> = self
            .clients
            .iter()
            .filter_map(|(&id, c)| (!self.table_screen_valid(c)).then_some(id))
            .collect();
        for id in close {
            self.return_crafting(id);
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
        self.within_reach(client.pos, [x, y, z])
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
    /// Unrequested results are ignored; loaded or stored chunks are never overwritten.
    pub fn deliver_generated(&mut self, cx: i32, cz: i32, bytes: &[u8]) -> bool {
        let c = (cx, cz);
        if !self.generating.contains(&c) {
            return false;
        }
        self.finish_generation_request(c);
        if self.world.chunks.contains_key(&c) || self.stored.contains(&c) {
            return false;
        }
        match Self::read_saved_chunk(cx, cz, bytes) {
            Ok(SavedChunk {
                chunk, furnaces, ..
            }) => {
                self.furnaces.extend(furnaces);
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

    /// Synchronous fallback for unsaved chunks; also completes any external request.
    pub fn generate_now(&mut self, cx: i32, cz: i32) {
        let c = (cx, cz);
        self.finish_generation_request(c);
        if self.world.chunks.contains_key(&c) || self.stored.contains(&c) {
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
                let keep = chunk.dirty || players_keep_chunk(clients, cx, cz);
                (!keep).then_some((cx, cz))
            })
            .collect();
        if !removed.is_empty() {
            let keep = |[x, _, z]: [i32; 3]| removed.binary_search(&(x >> 4, z >> 4)).is_err();
            self.scheduled_blocks.retain(|&(_, pos)| keep(pos));
            self.scheduled_block_times.retain(|&pos, _| keep(pos));
        }
        for (cx, cz) in removed {
            self.world.remove_chunk(cx, cz);
            self.furnaces
                .retain(|p, _| (p[0] >> 4, p[2] >> 4) != (cx, cz));
            self.entities.retain(|_, e| e.chunk() != (cx, cz));
            self.mobs.retain(|_, mob| mob.chunk() != (cx, cz));
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
        match Self::read_saved_chunk(cx, cz, bytes) {
            Ok(SavedChunk {
                chunk,
                furnaces,
                scheduled_blocks,
            }) => {
                for (delay, pos) in scheduled_blocks {
                    self.queue_scheduled_tick(pos, self.game_time.saturating_add(i64::from(delay)));
                }
                self.furnaces.extend(furnaces);
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
        let (cx, cz) = (chunk.cx, chunk.cz);
        let mut w = world::io::Writer::new();
        w.raw(&chunk.to_bytes());
        let entries: Vec<_> = self
            .furnaces
            .iter()
            .filter(|(p, _)| (p[0] >> 4, p[2] >> 4) == (cx, cz))
            .collect();
        w.varint(entries.len() as u32);
        for (p, f) in entries {
            w.u8(p[0].rem_euclid(16) as u8);
            w.i32(p[1]);
            w.u8(p[2].rem_euclid(16) as u8);
            f.write(&mut w);
        }
        let scheduled: Vec<_> = self
            .scheduled_blocks
            .iter()
            .filter(|(_, [x, _, z])| (x >> 4, z >> 4) == (cx, cz))
            .collect();
        w.varint(scheduled.len() as u32);
        for (time, [x, y, z]) in scheduled {
            w.u8((x & 15) as u8);
            w.i32(*y);
            w.u8((z & 15) as u8);
            w.u16(
                time.saturating_sub(self.game_time)
                    .clamp(0, i64::from(u16::MAX)) as u16,
            );
        }
        Some((cx, cz, w.finish()))
    }

    fn read_saved_chunk(
        cx: i32,
        cz: i32,
        bytes: &[u8],
    ) -> Result<SavedChunk, world::io::DecodeError> {
        use world::io::DecodeError;
        let mut r = Reader::new(bytes);
        // Chunk::read deliberately rejects trailing bytes. Locate its prefix here.
        for _ in 0..world::SECTIONS {
            r.u16()?;
            world::PalettedContainer::read(&mut r, blocks::COUNT)?;
        }
        let prefix = bytes.len() - r.remaining();
        let chunk = Chunk::read(cx, cz, &mut Reader::new(&bytes[..prefix]))?;
        let mut furnaces = BTreeMap::new();
        if r.remaining() > 0 {
            let count = r.varint()? as usize;
            if count > 16 * 16 * HEIGHT as usize || r.remaining() < count * 25 {
                return Err(DecodeError);
            }
            for _ in 0..count {
                let x = r.u8()?;
                let y = r.i32()?;
                let z = r.u8()?;
                if x >= 16 || z >= 16 || !(MIN_Y..MIN_Y + HEIGHT).contains(&y) {
                    return Err(DecodeError);
                }
                let p = [
                    cx.wrapping_mul(16).wrapping_add(x as i32),
                    y,
                    cz.wrapping_mul(16).wrapping_add(z as i32),
                ];
                if chunk.get(x as usize, y, z as usize) != blocks::FURNACE {
                    return Err(DecodeError);
                }
                if furnaces
                    .insert(p, furnace::Furnace::read(&mut r)?)
                    .is_some()
                {
                    return Err(DecodeError);
                }
            }
        }
        let mut scheduled_blocks = Vec::new();
        if r.remaining() > 0 {
            let count = r.varint()? as usize;
            if !r.remaining().is_multiple_of(8) || count != r.remaining() / 8 {
                return Err(DecodeError);
            }
            for _ in 0..count {
                let x = r.u8()?;
                let y = r.i32()?;
                let z = r.u8()?;
                let delay = r.u16()?;
                if x >= 16 || z >= 16 || !(MIN_Y..MIN_Y + HEIGHT).contains(&y) {
                    return Err(DecodeError);
                }
                let pos = [
                    cx.wrapping_mul(16).wrapping_add(i32::from(x)),
                    y,
                    cz.wrapping_mul(16).wrapping_add(i32::from(z)),
                ];
                scheduled_blocks.push((delay, pos));
            }
        }
        Ok(SavedChunk {
            chunk,
            furnaces,
            scheduled_blocks,
        })
    }
    pub fn dirty_chunks(&self) -> usize {
        self.world.chunks.values().filter(|c| c.dirty).count()
    }

    // ---- inspection --------------------------------------------------------

    pub fn get_block(&self, x: i32, y: i32, z: i32) -> Option<u16> {
        self.world.get_block(x, y, z)
    }

    /// Fingerprint of the clock, mode, connected inventories, and every loaded block.
    pub fn state_hash(&self) -> u64 {
        let mut h = Fnv64::new();
        h.i64(self.seed);
        h.i64(self.game_time);
        h.i64(self.day_time);
        h.u8(self.game_mode as u8);
        h.i64(self.clients.len() as i64);
        for (&id, client) in &self.clients {
            h.bytes(&id.to_be_bytes());
            // Keep the state hash independent of inventory persistence versions.
            // The original inventory hash prefix is retained for compatibility.
            h.u8(1);
            h.u8(client.inventory.selected());
            for slot in client
                .inventory
                .slots()
                .iter()
                .copied()
                .chain(client.inventory.crafting)
                .chain([client.inventory.cursor])
                .chain(client.inventory.table)
            {
                h.bytes(&slot.map_or(0, |s| s.item).to_be_bytes());
                h.u8(slot.map_or(0, |s| s.count));
            }
            h.u8(match client.inventory.screen {
                inventory::Screen::None => 0,
                inventory::Screen::CraftingTable { .. } => 1,
                inventory::Screen::Furnace { .. } => 2,
            });
            if let inventory::Screen::CraftingTable { pos } | inventory::Screen::Furnace { pos } =
                client.inventory.screen
            {
                for v in pos {
                    h.bytes(&v.to_be_bytes());
                }
            }
            if !self.mobs.is_empty() {
                h.bytes(&client.yaw.to_bits().to_be_bytes());
            }
            client.health.hash_into(&mut h);
            client.survival_movement.hash_into(&mut h);
            h.u8(client.dig.is_some() as u8);
            if let Some(dig) = client.dig {
                for v in dig.pos {
                    h.bytes(&v.to_be_bytes());
                }
                h.bytes(&dig.state.to_be_bytes());
                h.i64(dig.start);
                h.bytes(&dig.ticks.to_be_bytes());
                h.u8(dig.stage.unwrap_or(255));
                h.u8(u8::from(dig.drops));
            }
        }
        h.i64(self.furnaces.len() as i64);
        for (pos, f) in &self.furnaces {
            for v in pos {
                h.bytes(&v.to_be_bytes());
            }
            let mut w = world::io::Writer::new();
            f.write(&mut w);
            h.bytes(&w.finish());
        }
        h.i64(self.scheduled_blocks.len() as i64);
        for (time, pos) in &self.scheduled_blocks {
            h.i64(*time);
            for v in pos {
                h.i32(*v);
            }
        }
        h.bytes(&self.next_entity_id.to_be_bytes());
        h.i64(self.entities.len() as i64);
        for (&id, e) in &self.entities {
            h.bytes(&id.to_be_bytes());
            h.u8(e.kind as u8);
            for v in e.pos.into_iter().chain(e.velocity) {
                h.bytes(&v.to_bits().to_be_bytes());
            }
            h.bytes(&e.item.to_be_bytes());
            h.u8(e.count);
            h.bytes(&e.age.to_be_bytes());
            h.bytes(&e.pickup_delay.to_be_bytes());
            h.u8(e.on_ground as u8);
        }
        self.hash_mobs(&mut h);
        self.world.hash_into(&mut h);
        h.finish()
    }
}

fn crosses_lava(world: &World, previous: [f64; 3], current: [f64; 3]) -> bool {
    const MAX_CELLS: usize = 64;
    let is_lava = |[x, y, z]: [i32; 3]| {
        (MIN_Y..MIN_Y + HEIGHT).contains(&y)
            && world.get_block(x, y, z).is_some_and(blocks::is_lava)
    };
    let mut cell = previous.map(|v| v.floor() as i32);
    let end = current.map(|v| v.floor() as i32);
    let step: [i32; 3] = std::array::from_fn(|axis| if end[axis] > cell[axis] { 1 } else { -1 });
    let delta: [f64; 3] = std::array::from_fn(|axis| current[axis] - previous[axis]);

    // Endpoints use floor; tied crossings step together, skipping cells only grazed at an edge or corner.
    // Reserve the last check for the endpoint even when the traversal reaches its limit.
    for _ in 0..MAX_CELLS - 1 {
        if is_lava(cell) {
            return true;
        }
        if cell == end {
            return false;
        }

        let next: [f64; 3] = std::array::from_fn(|axis| {
            if cell[axis] == end[axis] {
                f64::INFINITY
            } else {
                let boundary = f64::from(cell[axis]) + f64::from(i32::from(step[axis] > 0));
                (boundary - previous[axis]) / delta[axis]
            }
        });
        let nearest = next
            .into_iter()
            .fold(f64::INFINITY, |best, t| if t < best { t } else { best });
        for axis in 0..3 {
            if next[axis] == nearest {
                cell[axis] += step[axis];
            }
        }
    }
    is_lava(end)
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

    #[test]
    fn item_spawned_in_lava_is_removed_even_if_it_moves_out_on_its_first_tick() {
        let mut s = Server::new(1, Generator::Flat);
        s.world.insert_chunk(world::Chunk::empty(0, 0));
        s.world.set_block(2, 80, 2, blocks::LAVA);

        let id = s.next_entity_id;
        s.spawn_item(1, 1, [2.5, 80.9, 2.5], [0.0, 0.3, 0.0], 40);
        let mut item = s.entities[&id].clone();
        item.tick(&s.world);
        assert!(item.pos[1] >= 81.0);

        s.tick_entities();
        assert!(!s.entities.contains_key(&id));
    }

    #[test]
    fn item_falling_through_lava_in_one_tick_is_removed() {
        let mut s = Server::new(1, Generator::Flat);
        s.world.insert_chunk(world::Chunk::empty(0, 0));
        s.world.set_block(2, 80, 2, blocks::OAK_SLAB);
        s.world.set_block(2, 81, 2, blocks::LAVA);

        let id = s.next_entity_id;
        s.spawn_item(1, 1, [2.5, 82.25, 2.5], [0.0, -2.0, 0.0], 40);
        let mut item = s.entities[&id].clone();
        item.tick(&s.world);
        assert!(item.on_ground);
        assert_eq!(item.pos[1], 80.5);

        s.tick_entities();
        assert!(!s.entities.contains_key(&id));
    }

    #[test]
    fn item_falling_diagonally_past_lava_is_not_removed() {
        let mut s = Server::new(1, Generator::Flat);
        s.world.insert_chunk(Chunk::empty(0, 0));
        s.world.set_block(3, 82, 2, blocks::LAVA);

        let id = s.next_entity_id;
        s.spawn_item(1, 1, [2.8, 82.25, 2.5], [0.3, -2.0, 0.0], 40);
        s.tick_entities();

        assert_eq!(s.entities[&id].pos.map(|v| v.floor() as i32), [3, 80, 2]);
    }

    #[test]
    fn lava_path_checks_endpoints_and_skips_cells_only_grazed_at_a_corner() {
        let mut world = World::with_lighting(false);
        world.insert_chunk(Chunk::empty(0, 0));
        let start = [2.5, 80.5, 2.5];
        let corner = [3.0, 81.0, 3.0];
        let end = [3.5, 81.5, 3.5];
        world.set_block(3, 80, 2, blocks::LAVA);
        assert!(!crosses_lava(&world, start, end));
        assert!(!crosses_lava(&world, end, start));
        assert!(!crosses_lava(&world, start, start));

        world.set_block(3, 81, 3, blocks::LAVA);
        assert!(crosses_lava(&world, start, corner));
        assert!(crosses_lava(&world, corner, start));
        assert!(crosses_lava(&world, corner, corner));
    }

    #[test]
    fn crowded_unmergeable_items_respect_comparison_budget() {
        let mut s = Server::new(1, Generator::Flat);
        s.generate_now(0, 0);
        for _ in 0..1024 {
            s.spawn_item(1, 40, [2.5, 80.0, 2.5], [0.0; 3], 40);
        }
        assert_eq!(s.merge_entities(), 4096);
        assert_eq!(s.entities.len(), 1024);
        assert!(s.entities.values().all(|e| e.count == 40));
        assert_eq!(s.merge_entities(), 4096);
    }

    #[test]
    fn merge_grid_filters_full_distant_and_other_items_and_orders_neighbor_ids() {
        let mut s = Server::new(1, Generator::Flat);
        s.generate_now(0, 0);
        // Both neighboring cells are visited before comparing, in global ID order.
        s.spawn_item(1, 40, [2.0, 80.0, 2.5], [0.0; 3], 40);
        s.spawn_item(1, 24, [2.5, 80.0, 2.5], [0.0; 3], 40);
        s.spawn_item(1, 24, [1.5, 80.0, 2.5], [0.0; 3], 40);
        assert_eq!(s.merge_entities(), 1);
        assert_eq!(s.entities[&1].count, 64);
        assert!(!s.entities.contains_key(&2));
        assert_eq!(s.entities[&3].count, 24);
        s.entities.clear();
        for _ in 0..1024 {
            s.spawn_item(1, 64, [2.5, 80.0, 2.5], [0.0; 3], 40);
        }
        assert_eq!(s.merge_entities(), 0);
        s.entities.clear();
        s.spawn_item(1, 40, [2.5, 80.0, 2.5], [0.0; 3], 40);
        s.spawn_item(2, 40, [2.5, 80.0, 2.5], [0.0; 3], 40);
        s.spawn_item(1, 40, [8.5, 80.0, 2.5], [0.0; 3], 40);
        assert_eq!(s.merge_entities(), 0);
    }

    fn survival() -> (Server, [i32; 3]) {
        let mut s = Server::new(1, Generator::Flat);
        s.set_game_mode(GameMode::Survival);
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
        let [x, y, z] = s.spawn();
        s.take_outbox();
        (s, [x.floor() as i32, y as i32, z.floor() as i32])
    }
    fn dig_start(s: &mut Server, id: u32, [x, y, z]: [i32; 3]) {
        s.handle_packet(id, &C2S::DigStart { x, y, z }.encode());
    }
    fn edit(s: &mut Server, [x, y, z]: [i32; 3], state: u16) {
        s.handle_packet(1, &C2S::SetBlock { x, y, z, state }.encode());
    }
    fn inventories(s: &mut Server) -> Vec<S2C> {
        decode_all(s.take_outbox())
            .into_iter()
            .filter_map(|(_, p)| matches!(p, S2C::Inventory { .. }).then_some(p))
            .collect()
    }
    #[test]
    fn survival_breaks_collect_and_placements_consume_all_block_states() {
        let (mut s, pos) = survival();
        assert_eq!(s.clients[&1].inventory, Inventory::default());
        for (state, placed) in [
            (blocks::STONE, blocks::COBBLESTONE),
            (blocks::OAK_SLAB + 1, blocks::OAK_SLAB + 1),
            (blocks::OAK_STAIRS + 7, blocks::OAK_STAIRS + 7),
        ] {
            s.world.set_block(pos[0], pos[1], pos[2], state);
            if state == blocks::STONE {
                let inv = &mut s.clients.get_mut(&1).unwrap().inventory;
                inv.set(
                    8,
                    Some(Stack {
                        item: items::by_name("wooden_pickaxe").unwrap(),
                        count: 1,
                    }),
                )
                .unwrap();
                inv.select(8).unwrap();
            }
            let ticks = items::mining(
                state,
                s.clients[&1]
                    .inventory
                    .selected_stack()
                    .map(|stack| stack.item),
            )
            .unwrap()
            .0;
            dig_start(&mut s, 1, pos);
            for _ in 0..=ticks {
                s.tick();
            }
            assert_eq!(s.entities.len(), 1);
            s.clients.get_mut(&1).unwrap().inventory.select(0).unwrap();
            assert!(s.clients[&1].inventory.selected_stack().is_none());
            for _ in 0..9 {
                s.tick();
            }
            assert!(s.entities.is_empty());
            assert_eq!(
                s.clients[&1].inventory.selected_stack(),
                Some(Stack {
                    item: items::for_block(placed).unwrap(),
                    count: 1
                })
            );
            assert_eq!(inventories(&mut s).len(), 1);
            edit(&mut s, pos, placed);
            s.tick();
            assert!(s.clients[&1].inventory.selected_stack().is_none());
            assert_eq!(inventories(&mut s).len(), 1);
            assert_eq!(s.get_block(pos[0], pos[1], pos[2]), Some(placed));
        }
        // A stone item still places stone, independently of the mining override.
        s.world.set_block(pos[0], pos[1], pos[2], blocks::AIR);
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(
                0,
                Some(Stack {
                    item: items::by_name("stone").unwrap(),
                    count: 1,
                }),
            )
            .unwrap();
        edit(&mut s, pos, blocks::STONE);
        s.tick();
        assert_eq!(s.get_block(pos[0], pos[1], pos[2]), Some(blocks::STONE));
        assert!(s.clients[&1].inventory.selected_stack().is_none());
        assert_eq!(s.stats.packets_rejected, 0);
    }
    #[test]
    fn survival_places_persistent_leaves_and_mines_them_without_an_apple_roll() {
        let (mut s, [x, y, z]) = survival();
        s.seed = 5; // The first terrain-leaf drop at this seed would be an apple.
        assert!(s.leaf_drops_apple());
        let pos = [x + 1, y, z];
        let leaves = items::by_name("oak_leaves").unwrap();
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(
                0,
                Some(Stack {
                    item: leaves,
                    count: 1,
                }),
            )
            .unwrap();
        edit(&mut s, pos, blocks::OAK_LEAVES);
        s.tick();
        assert_eq!(s.get_block(pos[0], y, z), Some(blocks::AIR));

        let placed = items::info(leaves).unwrap().block.unwrap();
        edit(&mut s, pos, placed);
        s.tick();
        assert_eq!(s.get_block(pos[0], y, z), Some(blocks::PLACED_OAK_LEAVES));
        assert!(s.clients[&1].inventory.selected_stack().is_none());

        dig_start(&mut s, 1, pos);
        let ticks = items::mining(placed, None).unwrap().0;
        for _ in 0..=ticks {
            s.tick();
        }
        assert_eq!(s.get_block(pos[0], y, z), Some(blocks::AIR));
        assert_eq!(s.entities.len(), 1);
        let drop = s.entities.values().next().unwrap();
        assert_eq!((drop.item, drop.count), (leaves, 1));
    }

    #[test]
    fn survival_rejects_empty_wrong_items_and_unbreakable_blocks_with_correction() {
        let (mut s, pos) = survival();
        s.world.set_block(pos[0], pos[1], pos[2], blocks::AIR);
        edit(&mut s, pos, blocks::STONE);
        s.tick();
        assert_eq!(s.stats.packets_rejected, 1);
        assert_eq!(s.stats.edits_corrected, 1);
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .add(items::for_block(blocks::DIRT).unwrap(), 1);
        edit(&mut s, pos, blocks::STONE);
        s.tick();
        assert_eq!(s.stats.packets_rejected, 2);
        assert_eq!(s.get_block(pos[0], pos[1], pos[2]), Some(blocks::AIR));
        for state in [blocks::BEDROCK, blocks::WATER] {
            s.world.set_block(pos[0], pos[1], pos[2], state);
            edit(&mut s, pos, blocks::AIR);
            s.tick();
            assert_eq!(s.get_block(pos[0], pos[1], pos[2]), Some(state));
        }
        assert_eq!(s.stats.packets_rejected, 4);
        assert_eq!(s.stats.edits_corrected, 4);
        assert_eq!(s.clients[&1].inventory.selected_stack().unwrap().count, 1);
    }
    #[test]
    fn survival_placement_rejects_overwriting_bedrock_and_other_blocks() {
        for old in [blocks::BEDROCK, blocks::STONE] {
            let (mut s, [x, y, z]) = survival();
            s.world.set_block(x, y, z, old);
            s.clients
                .get_mut(&1)
                .unwrap()
                .inventory
                .add(items::for_block(blocks::DIRT).unwrap(), 2);
            let before = s.inventory_data(1);
            edit(&mut s, [x, y, z], blocks::DIRT);
            s.tick();
            assert_eq!(s.get_block(x, y, z), Some(old));
            assert_eq!(s.inventory_data(1), before);
            assert_eq!(s.stats.blocks_changed, 0);
            assert_eq!(s.stats.packets_rejected, 1);
            assert_eq!(s.stats.edits_corrected, 1);
            let updates: Vec<_> = decode_all(s.take_outbox())
                .into_iter()
                .filter(|(_, p)| matches!(p, S2C::BlockUpdate { .. } | S2C::Inventory { .. }))
                .collect();
            assert_eq!(
                updates,
                vec![(
                    1,
                    S2C::BlockUpdate {
                        x,
                        y,
                        z,
                        state: old
                    }
                )]
            );
        }
    }

    #[test]
    fn survival_placement_allows_replaceable_blocks_and_slab_state_changes() {
        for (old, new) in [
            (blocks::AIR, blocks::DIRT),
            (blocks::WATER, blocks::DIRT),
            (blocks::SHORT_GRASS, blocks::DIRT),
            (blocks::OAK_SLAB, blocks::OAK_SLAB + 2),
        ] {
            let (mut s, [x, y, z]) = survival();
            s.world.set_block(x, y, z, old);
            let item = items::for_block(new).unwrap();
            s.clients.get_mut(&1).unwrap().inventory.add(item, 2);
            edit(&mut s, [x, y, z], new);
            s.tick();
            assert_eq!(s.get_block(x, y, z), Some(new));
            assert_eq!(
                s.clients[&1].inventory.selected_stack(),
                Some(Stack { item, count: 1 })
            );
            assert_eq!(s.stats.blocks_changed, 1);
            assert_eq!(s.stats.packets_rejected, 0);
            assert_eq!(s.stats.edits_corrected, 0);
            assert_eq!(inventories(&mut s).len(), 1);
        }
    }

    #[test]
    fn full_survival_inventory_preserves_dropped_overflow() {
        let (mut s, pos) = survival();
        let inv = &mut s.clients.get_mut(&1).unwrap().inventory;
        assert_eq!(inv.add(1, 36 * 64), 0);
        let before = inv.clone();
        s.world.set_block(pos[0], pos[1], pos[2], blocks::DIRT);
        dig_start(&mut s, 1, pos);
        for _ in 0..=12 {
            s.tick();
        }
        for _ in 0..10 {
            s.tick();
        }
        assert_eq!(s.entities.len(), 1);
        assert_eq!(s.clients[&1].inventory, before);
        assert_eq!(s.get_block(pos[0], pos[1], pos[2]), Some(blocks::AIR));
        assert!(inventories(&mut s).is_empty());
    }
    #[test]
    fn slots_validate_permissions_ranges_and_resend_authoritative_inventory() {
        let (mut s, _) = survival();
        s.handle_packet(
            1,
            &C2S::CreativeSetSlot {
                slot: 0,
                item: 1,
                count: 1,
            }
            .encode(),
        );
        s.handle_packet(1, &C2S::SelectSlot { slot: 9 }.encode());
        s.tick();
        assert_eq!(s.stats.packets_rejected, 2);
        assert_eq!(s.clients[&1].inventory, Inventory::default());
        assert_eq!(inventories(&mut s).len(), 1);
        s.handle_packet(1, &C2S::SelectSlot { slot: 8 }.encode());
        s.tick();
        assert_eq!(s.clients[&1].inventory.selected(), 8);
        assert_eq!(inventories(&mut s).len(), 1);
        s.set_game_mode(GameMode::Creative);
        for packet in [
            C2S::CreativeSetSlot {
                slot: 36,
                item: 1,
                count: 1,
            },
            C2S::CreativeSetSlot {
                slot: 0,
                item: u16::MAX,
                count: 1,
            },
            C2S::CreativeSetSlot {
                slot: 0,
                item: 1,
                count: 65,
            },
            C2S::CreativeSetSlot {
                slot: 0,
                item: 1,
                count: 0,
            },
        ] {
            s.handle_packet(1, &packet.encode());
        }
        s.tick();
        assert_eq!(s.stats.packets_rejected, 6);
        assert_eq!(inventories(&mut s).len(), 1);
    }
    #[test]
    fn creative_defaults_unrestricted_edits_and_inventory_batching() {
        let mut s = joined(2);
        s.tick();
        let packets = decode_all(s.take_outbox());
        assert!(matches!(packets[0].1, S2C::Welcome { game_mode: 0, .. }));
        assert!(matches!(packets[1].1, S2C::Inventory { selected: 0, .. }));
        assert_eq!(s.clients[&1].inventory, Inventory::creative());
        let [x, y, z] = s.spawn();
        let pos = [x.floor() as i32, y as i32, z.floor() as i32];
        let before = s.inventory_data(1);
        for state in [
            blocks::WATER,
            blocks::AIR,
            blocks::BEDROCK,
            blocks::AIR,
            blocks::OAK_STAIRS + 6,
        ] {
            edit(&mut s, pos, state);
        }
        s.tick();
        assert_eq!(s.stats.packets_rejected, 0);
        assert_eq!(s.inventory_data(1), before);
        assert!(inventories(&mut s).is_empty());
        for slot in [1, 2, 8] {
            s.handle_packet(1, &C2S::SelectSlot { slot }.encode());
        }
        s.handle_packet(
            1,
            &C2S::CreativeSetSlot {
                slot: 35,
                item: 1,
                count: 64,
            }
            .encode(),
        );
        s.tick();
        assert_eq!(inventories(&mut s).len(), 1);
        assert_eq!(s.clients[&1].inventory.selected(), 8);
        s.tick();
        assert!(inventories(&mut s).is_empty());
        s.handle_packet(
            1,
            &C2S::CreativeSetSlot {
                slot: 35,
                item: 0,
                count: 0,
            }
            .encode(),
        );
        s.tick();
        assert_eq!(s.clients[&1].inventory.slots()[35], None);
    }
    #[test]
    fn inventory_reconnect_and_hash_include_mode_and_client_order() {
        let (mut s, _) = survival();
        s.clients.get_mut(&1).unwrap().inventory.add(1, 70);
        s.clients.get_mut(&1).unwrap().inventory.select(5).unwrap();
        let bytes = s.inventory_data(1).unwrap();
        s.disconnect(1);
        assert_eq!(s.inventory_data(1), None);
        s.connect_at(1, false, None, Some(&bytes));
        assert_eq!(s.inventory_data(1), Some(bytes));
        let hash = s.state_hash();
        s.set_game_mode(GameMode::Creative);
        assert_ne!(s.state_hash(), hash);
        s.set_game_mode(GameMode::Survival);
        s.connect_at(1, false, None, Some(&[1, 2, 3]));
        assert_eq!(s.clients[&1].inventory, Inventory::default());
        assert_ne!(s.state_hash(), hash);
        s.set_game_mode(GameMode::Creative);
        s.connect_at(1, false, None, Some(&[0]));
        assert_eq!(s.clients[&1].inventory, Inventory::creative());
        let mut a = Server::new(1, Generator::Flat);
        let mut b = Server::new(1, Generator::Flat);
        for id in [1, 2] {
            a.connect(id);
        }
        for id in [2, 1] {
            b.connect(id);
        }
        assert_eq!(a.state_hash(), b.state_hash());
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
        s.connect_at(1, false, Some(position), None);
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
    fn survival_accepts_upward_slab_landings_with_individual_and_batched_packets() {
        let start = [0.69, 65.0, 0.5];
        for batched in [false, true] {
            let mut s = joined_at(start);
            s.set_game_mode(GameMode::Survival);
            for x in 0..4 {
                for z in 0..4 {
                    s.world.set_block(x, 63, z, blocks::STONE);
                }
            }
            s.world.set_block(1, 64, 0, blocks::OAK_SLAB);
            let mut player = physics::Player::new(start);
            for tick in 0..6 {
                if tick == 5 {
                    assert!(!player.on_ground);
                    assert!((player.position[1] - 64.23152379758702).abs() < 1e-12);
                    player.velocity[0] = 0.15;
                }
                player.tick(
                    physics::Input::default(),
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
                s.handle_packet(1, &position_packet(player.position));
                if !batched {
                    s.tick();
                    assert_eq!(s.stats.packets_rejected, 0, "tick {tick}");
                    assert_eq!(s.client_position(1), Some(player.position));
                }
            }
            assert!(player.on_ground);
            for (actual, expected) in player.position.into_iter().zip([0.84, 64.5, 0.5]) {
                assert!((actual - expected).abs() < 1e-12);
            }
            if batched {
                s.tick();
                assert_eq!(s.stats.packets_rejected, 0);
                assert_eq!(s.client_position(1), Some(player.position));
            }
        }
    }

    #[test]
    fn survival_accepts_swimming_and_climbing_ashore_with_batched_or_individual_reports() {
        let start = [0.5, 64.0, 0.5];
        for batch_size in [1, 4] {
            let mut s = joined_at(start);
            s.set_game_mode(GameMode::Survival);
            for x in 0..8 {
                for y in 64..67 {
                    let state = if x >= 2 || (x == 1 && y < 66) {
                        blocks::STONE
                    } else {
                        blocks::WATER
                    };
                    s.world.set_block(x, y, 0, state);
                }
                s.world.set_block(x, 63, 0, blocks::STONE);
            }
            let mut player = physics::Player::new(start);
            let mut bobbed = false;
            let mut kicked = false;
            for tick in 0..132 {
                let before = player.position;
                player.tick(
                    physics::Input {
                        jump: tick < 120,
                        strafe: if (80..120).contains(&tick) { -1.0 } else { 0.0 },
                        ..Default::default()
                    },
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
                bobbed |= tick < 80 && before[1] > 66.6 && player.position[1] < 66.6;
                kicked |= player.in_water && player.velocity[1] == 0.3;
                s.handle_packet(1, &position_packet(player.position));
                if (tick + 1) % batch_size == 0 {
                    s.tick();
                    assert_eq!(s.stats.packets_rejected, 0, "tick {tick}, {player:?}");
                    assert_eq!(s.stats.positions_rejected, 0, "tick {tick}");
                    assert_eq!(s.client_position(1), Some(player.position));
                }
            }
            assert!(bobbed && kicked);
            assert!(
                player.position[0] > 2.0 && player.position[1] >= 67.0,
                "{player:?}"
            );
        }
    }

    #[test]
    fn survival_accepts_rising_in_lava_and_climbing_ashore() {
        let start = [0.5, 65.0, 0.5];
        let mut s = joined_at(start);
        s.set_game_mode(GameMode::Survival);
        for y in 64..67 {
            s.world.set_block(0, y, 0, blocks::LAVA);
            s.world.set_block(1, y, 0, blocks::STONE);
            s.world.set_block(2, y, 0, blocks::STONE);
        }
        s.world.set_block(0, 63, 0, blocks::STONE);
        let mut player = physics::Player::new(start);
        let mut kicked = false;
        for tick in 0..45 {
            player.tick(
                physics::Input {
                    jump: true,
                    strafe: -1.0,
                    ..Default::default()
                },
                &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
            );
            kicked |= player.in_water && player.velocity[1] == 0.3;
            s.handle_packet(1, &position_packet(player.position));
            s.tick();
            assert_eq!(s.stats.positions_rejected, 0, "tick {tick}, {player:?}");
            assert_eq!(s.client_position(1), Some(player.position));
            if player.on_ground && player.position[0] >= 1.0 && player.position[1] >= 67.0 {
                assert!(kicked);
                return;
            }
        }
        panic!("player did not climb ashore: {player:?}");
    }

    #[test]
    fn survival_checks_water_exit_rise_with_batched_or_individual_reports() {
        let from = [0.5, 66.25, 0.5];
        for batched in [false, true] {
            let start = if batched { [0.5, 66.5, 0.5] } else { from };
            let mut s = joined_at(start);
            s.set_game_mode(GameMode::Survival);
            s.world.set_block(0, 66, 0, blocks::WATER);
            let too_high = [0.5, from[1] + MAX_SURVIVAL_RISE + 0.125, 0.5];
            assert!(movement_clear(&s.world, from, too_high));

            if batched {
                // Descend in water before immediately reporting the exit.
                s.handle_packet(1, &position_packet(from));
            }
            s.handle_packet(1, &position_packet(too_high));
            s.tick();
            assert_eq!(s.client_position(1), Some(from));
            assert_eq!(s.stats.packets_rejected, 1);
            assert_eq!(s.stats.positions_rejected, 1);
            if batched {
                let movement = s.clients[&1].survival_movement;
                assert_eq!(movement.jump_base_y, Some(from[1]));
                assert!(movement.airborne_progress.is_none());
            }

            let exit = [0.5, from[1] + MAX_SURVIVAL_RISE, 0.5];
            s.handle_packet(1, &position_packet(exit));
            s.tick();
            assert_eq!(s.client_position(1), Some(exit));
            assert_eq!(s.stats.packets_rejected, 1);
            assert_eq!(s.stats.positions_rejected, 1);
            let movement = s.clients[&1].survival_movement;
            assert_eq!(movement.jump_base_y, Some(from[1]));
            assert!(movement.airborne_progress.is_some());
        }
    }

    #[test]
    fn survival_rejects_excessive_dry_rise_after_leaving_water() {
        let start = [0.5, 66.5, 0.5];
        let mut s = joined_at(start);
        s.set_game_mode(GameMode::Survival);
        s.world.set_block(0, 66, 0, blocks::WATER);
        let exit = [0.5, 66.7, 0.5];
        s.handle_packet(1, &position_packet(exit));
        s.tick();
        assert_eq!(s.client_position(1), Some(exit));
        assert_eq!(s.stats.positions_rejected, 0);

        s.handle_packet(1, &position_packet([0.5, 68.3, 0.5]));
        s.tick();
        assert_eq!(s.client_position(1), Some(exit));
        assert_eq!(s.stats.packets_rejected, 1);
        assert_eq!(s.stats.positions_rejected, 1);
    }

    #[test]
    fn survival_accepts_jumping_after_landing_and_moving_off_the_edge() {
        let start = [1.2, 65.1, 0.5];
        let mut s = joined_at(start);
        s.set_game_mode(GameMode::Survival);
        s.world.set_block(0, 64, 0, blocks::STONE);
        let mut player = physics::Player::new(start);
        player.velocity = [0.2, -0.2, 0.0];
        player.tick(
            physics::Input::default(),
            &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
        );
        assert!(player.on_ground);
        assert_eq!(player.position, [1.4, 65.0, 0.5]);
        assert!(!health::grounded(&s.world, player.position));
        s.handle_packet(1, &position_packet(player.position));
        s.tick();
        assert_eq!(s.client_position(1), Some(player.position));

        player.tick(
            physics::Input {
                jump: true,
                ..Default::default()
            },
            &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
        );
        assert_eq!(player.position[1], 65.0 + 0.42_f32 as f64);
        s.handle_packet(1, &position_packet(player.position));
        s.tick();
        assert_eq!(s.client_position(1), Some(player.position));
        assert_eq!(s.stats.packets_rejected, 0);
        assert_eq!(s.stats.positions_rejected, 0);
    }

    #[test]
    fn survival_rejects_unsupported_rise_within_step_height() {
        let from = [0.69, 64.23152379758702, 0.5];
        let to = [0.69, 64.5, 0.5];
        let mut s = joined_at(from);
        s.set_game_mode(GameMode::Survival);
        s.world.set_block(0, 63, 0, blocks::STONE);
        s.world.set_block(1, 64, 0, blocks::OAK_SLAB);
        assert!(!health::grounded(&s.world, from));
        assert!(!health::grounded(&s.world, to));
        assert!(movement_clear(&s.world, from, to));
        s.handle_packet(1, &position_packet(to));
        s.tick();
        assert_eq!(s.stats.packets_rejected, 1);
        assert_eq!(s.client_position(1), Some(from));
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
        s.connect_at(7, false, Some(start), None);
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
        s.connect_at(1, false, None, None);
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
                s.connect_at(1, false, Some(position), None);
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
                server.apply(
                    1,
                    C2S::Hello {
                        protocol: PROTOCOL_VERSION,
                        view_distance: 2,
                    },
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
            // Compare generation and streaming before random ticks affect chunks
            // that became available at different times on the two paths.
            for _ in 0..20 {
                synchronous.stream_chunks();
                external.stream_chunks();
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
    fn unsolicited_generated_chunks_are_ignored() {
        let mut s = Server::new(1, Generator::Flat);
        s.set_external_generation(1);
        assert!(!s.ensure_chunk((0, 0)));
        let bytes = worldgen::generate(Generator::Flat, 1, 4, 5).to_bytes();
        for bytes in [bytes.as_slice(), &[1, 2, 3]] {
            assert!(!s.deliver_generated(4, 5, bytes));
        }
        assert!(!s.world.chunks.contains_key(&(4, 5)));
        assert_eq!(s.stats.chunks_generated, 0);
        assert_eq!(s.take_generation_requests(), vec![(0, 0)]);
        assert!(s.generating.contains(&(0, 0)));
    }

    #[test]
    fn stored_chunks_are_not_generated_by_fallback_or_late_delivery() {
        let mut s = Server::new(1, Generator::Flat);
        s.set_external_generation(2);
        assert!(!s.ensure_chunk((0, 0)));
        assert!(!s.ensure_chunk((1, 0)));
        s.set_stored([(0, 0), (1, 0)]);
        s.generate_now(0, 0);
        let bytes = worldgen::generate(Generator::Flat, 1, 1, 0).to_bytes();
        assert!(!s.deliver_generated(1, 0, &bytes));
        assert!(s.generating.is_empty());
        assert!(s.take_generation_requests().is_empty());
        assert!(!s.ensure_chunk((0, 0)));
        assert!(!s.ensure_chunk((1, 0)));
        assert_eq!(s.take_requests(), vec![(0, 0), (1, 0)]);
        assert!(s.world.chunks.is_empty());
        assert_eq!(s.stats.chunks_generated, 0);
    }

    #[test]
    fn disabling_generation_and_late_results_preserve_unloaded_saved_edits() {
        let mut s = Server::new(1, Generator::Flat);
        s.set_external_generation(1);
        assert!(!s.ensure_chunk((0, 0)));
        let late = worldgen::generate(Generator::Flat, 1, 0, 0).to_bytes();
        s.set_external_generation(0);
        assert!(s.ensure_chunk((0, 0)));
        s.world.set_block(1, 80, 1, blocks::OAK_PLANKS);
        let (cx, cz, saved) = s.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        assert!(s.stored.contains(&(0, 0)));
        s.world.chunks.remove(&(0, 0)); // The saved chunk is unloaded.
        assert!(!s.deliver_generated(0, 0, &late));
        s.generate_now(0, 0);
        assert!(!s.world.chunks.contains_key(&(0, 0)));
        assert_eq!(s.stats.chunks_generated, 1);
        assert!(!s.ensure_chunk((0, 0)));
        assert_eq!(s.take_requests(), vec![(0, 0)]);
        assert!(s.load_chunk(0, 0, &saved));
        assert_eq!(s.get_block(1, 80, 1), Some(blocks::OAK_PLANKS));
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

#[cfg(test)]
mod mining;

#[cfg(test)]
mod crafting_server_tests {
    use super::*;
    fn server() -> Server {
        let mut s = Server::new(2026, Generator::Flat);
        s.connect_with_teleport(1, true);
        s.handle_packet(
            1,
            &C2S::Hello {
                protocol: protocol::PROTOCOL_VERSION,
                view_distance: 0,
            }
            .encode(),
        );
        s.tick();
        s.take_outbox();
        s
    }
    fn table(s: &mut Server) -> [i32; 3] {
        let p = s.clients[&1].pos;
        let pos = [
            p[0].floor() as i32 + 1,
            p[1].floor() as i32,
            p[2].floor() as i32,
        ];
        assert!(s
            .world
            .set_block(pos[0], pos[1], pos[2], blocks::CRAFTING_TABLE)
            .is_some());
        pos
    }
    fn use_table(s: &mut Server, [x, y, z]: [i32; 3]) {
        s.handle_packet(1, &C2S::UseBlock { x, y, z }.encode());
        s.tick();
    }
    #[test]
    fn opens_only_reachable_tables_and_rejects_inactive_grid_slots() {
        let mut s = server();
        let pos = table(&mut s);
        for slot in 41..=50 {
            s.handle_packet(
                1,
                &C2S::ClickSlot {
                    slot,
                    button: 0,
                    shift: false,
                }
                .encode(),
            );
        }
        s.tick();
        assert_eq!(s.stats.packets_rejected, 10);
        assert!(s
            .take_outbox()
            .iter()
            .any(|(_, p)| matches!(S2C::decode(p), Ok(S2C::Inventory { screen: 0, .. }))));
        use_table(&mut s, [pos[0], pos[1] + 1, pos[2]]);
        s.world
            .set_block(pos[0] + 10, pos[1], pos[2], blocks::CRAFTING_TABLE);
        use_table(&mut s, [pos[0] + 10, pos[1], pos[2]]);
        assert_eq!(s.stats.packets_rejected, 12);
        use_table(&mut s, pos);
        assert_eq!(
            s.clients[&1].inventory.screen,
            inventory::Screen::CraftingTable { pos }
        );
        assert!(s
            .take_outbox()
            .iter()
            .any(|(_, p)| matches!(S2C::decode(p), Ok(S2C::Inventory { screen: 1, .. }))));
        use_table(&mut s, pos);
        for slot in 36..=40 {
            s.handle_packet(
                1,
                &C2S::ClickSlot {
                    slot,
                    button: 0,
                    shift: false,
                }
                .encode(),
            );
        }
        s.tick();
        assert_eq!(s.stats.packets_rejected, 18);
    }
    #[test]
    fn log_to_wooden_pickaxe_through_packet_clicks() {
        let mut s = server();
        let pos = table(&mut s);
        s.clients.get_mut(&1).unwrap().inventory = Inventory::default();
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(0, Some(Stack { item: 8, count: 3 }))
            .unwrap();
        for (slot, button, shift) in [
            (0, 0, false),
            (36, 0, false),
            (40, 0, true),
            (0, 0, false),
            (36, 1, false),
            (38, 1, false),
            (1, 0, false),
            (40, 0, false),
            (2, 0, false),
        ] {
            s.handle_packet(
                1,
                &C2S::ClickSlot {
                    slot,
                    button,
                    shift,
                }
                .encode(),
            );
        }
        s.handle_packet(1, &C2S::CloseInventory.encode());
        use_table(&mut s, pos);
        for (slot, button) in [
            (1, 0),
            (41, 1),
            (42, 1),
            (43, 1),
            (1, 0),
            (2, 0),
            (45, 1),
            (48, 1),
            (2, 0),
            (50, 0),
            (3, 0),
        ] {
            s.handle_packet(
                1,
                &C2S::ClickSlot {
                    slot,
                    button,
                    shift: false,
                }
                .encode(),
            );
        }
        s.tick();
        let inv = &s.clients[&1].inventory;
        assert_eq!(
            inv.slots()[3],
            Some(Stack {
                item: items::by_name("wooden_pickaxe").unwrap(),
                count: 1
            })
        );
        assert_eq!(inv.table, [None; 9]);
        assert_eq!(s.stats.packets_rejected, 0);
    }
    #[test]
    fn mined_stone_to_stone_pickaxe_through_packet_clicks() {
        let mut s = server();
        s.set_game_mode(GameMode::Survival);
        let table_pos = table(&mut s);
        let [x, y, z] = s.clients[&1].pos.map(|v| v.floor() as i32);
        let wooden_pickaxe = items::by_name("wooden_pickaxe").unwrap();
        let cobblestone = items::by_name("cobblestone").unwrap();
        let stick = items::by_name("stick").unwrap();
        let inv = &mut s.clients.get_mut(&1).unwrap().inventory;
        *inv = Inventory::default();
        inv.set(
            0,
            Some(Stack {
                item: wooden_pickaxe,
                count: 1,
            }),
        )
        .unwrap();
        inv.set(
            1,
            Some(Stack {
                item: stick,
                count: 2,
            }),
        )
        .unwrap();

        for dz in 0..3 {
            let z = z + dz;
            s.world.set_block(x, y, z, blocks::STONE).unwrap();
            s.handle_packet(1, &C2S::DigStart { x, y, z }.encode());
            s.tick(); // Start tick has elapsed time zero.
            for _ in 0..35 {
                s.tick();
            }
            assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
            assert_eq!(s.entities.len(), 1);
            let entity = s.entities.values().next().unwrap();
            assert_eq!((entity.item, entity.count), (cobblestone, 1));
            assert!(s.take_outbox().iter().any(|(_, packet)| matches!(
                S2C::decode(packet),
                Ok(S2C::EntitySpawn { item, count: 1, .. }) if item == cobblestone
            )));
            s.handle_packet(
                1,
                &C2S::Teleport {
                    x: x as f64 + 0.5,
                    y: y as f64,
                    z: z as f64 + 0.5,
                }
                .encode(),
            );
            for _ in 0..30 {
                s.tick();
            }
            assert!(s.entities.is_empty());
            assert_eq!(
                s.clients[&1].inventory.slots()[2],
                Some(Stack {
                    item: cobblestone,
                    count: (dz + 1) as u8,
                })
            );
        }

        use_table(&mut s, table_pos);
        for (slot, button) in [(2, 0), (41, 1), (42, 1), (43, 1), (1, 0), (45, 1), (48, 1)] {
            s.handle_packet(
                1,
                &C2S::ClickSlot {
                    slot,
                    button,
                    shift: false,
                }
                .encode(),
            );
        }
        s.tick();
        assert_eq!(
            s.clients[&1].inventory.result(),
            Some(Stack {
                item: items::by_name("stone_pickaxe").unwrap(),
                count: 1,
            })
        );
        for slot in [50, 3] {
            s.handle_packet(
                1,
                &C2S::ClickSlot {
                    slot,
                    button: 0,
                    shift: false,
                }
                .encode(),
            );
        }
        s.tick();
        let inv = &s.clients[&1].inventory;
        assert_eq!(
            inv.slots()[3],
            Some(Stack {
                item: items::by_name("stone_pickaxe").unwrap(),
                count: 1,
            })
        );
        assert_eq!(
            inv.slots()[0],
            Some(Stack {
                item: wooden_pickaxe,
                count: 1
            })
        );
        assert_eq!(&inv.slots()[1..3], &[None, None]);
        assert_eq!(inv.table, [None; 9]);
        assert_eq!(inv.cursor, None);
        assert_eq!(s.stats.packets_rejected, 0);
    }

    #[test]
    fn result_click_rechecks_table_before_crafting_in_the_same_tick() {
        for broken in [false, true] {
            for full in [false, true] {
                let mut s = server();
                let pos = table(&mut s);
                // A small accepted PlayerPos movement will cross the reach boundary.
                let start = [
                    pos[0] as f64 + 0.5 - 7.9,
                    s.clients[&1].pos[1],
                    pos[2] as f64 + 0.5,
                ];
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
                let planks = items::by_name("oak_planks").unwrap();
                let stick = items::by_name("stick").unwrap();
                let pickaxe = items::by_name("wooden_pickaxe").unwrap();
                let inv = &mut s.clients.get_mut(&1).unwrap().inventory;
                *inv = Inventory::default();
                if full {
                    for slot in 0..36 {
                        inv.set(
                            slot,
                            Some(Stack {
                                item: items::by_name("stone").unwrap(),
                                count: 64,
                            }),
                        )
                        .unwrap();
                    }
                }
                for slot in [0, 1, 2] {
                    inv.table[slot] = Some(Stack {
                        item: planks,
                        count: 1,
                    });
                }
                for slot in [4, 7] {
                    inv.table[slot] = Some(Stack {
                        item: stick,
                        count: 1,
                    });
                }
                use_table(&mut s, pos);
                assert_eq!(
                    s.clients[&1].inventory.result(),
                    Some(Stack {
                        item: pickaxe,
                        count: 1
                    })
                );
                assert!(matches!(
                    s.clients[&1].inventory.screen,
                    inventory::Screen::CraftingTable { .. }
                ));
                s.take_outbox();
                let rejected = s.stats.packets_rejected;
                if broken {
                    s.world.set_block(pos[0], pos[1], pos[2], blocks::AIR);
                } else {
                    s.handle_packet(
                        1,
                        &C2S::PlayerPos {
                            x: start[0] - 0.3,
                            y: start[1],
                            z: start[2],
                            yaw: 0.0,
                            pitch: 0.0,
                        }
                        .encode(),
                    );
                }
                s.handle_packet(
                    1,
                    &C2S::ClickSlot {
                        slot: 50,
                        button: 0,
                        shift: false,
                    }
                    .encode(),
                );
                s.tick();
                assert_eq!(s.stats.positions_rejected, 0);
                if !broken {
                    assert_eq!(s.clients[&1].pos, [start[0] - 0.3, start[1], start[2]]);
                }
                assert_eq!(s.stats.packets_rejected, rejected + 1);
                let inv = &s.clients[&1].inventory;
                assert_eq!(inv.screen, inventory::Screen::None);
                assert_eq!(inv.table, [None; 9]);
                assert_eq!(inv.cursor, None);
                assert_eq!(inv.result(), None);
                let count = |item| {
                    inv.slots()
                        .iter()
                        .flatten()
                        .filter(|s| s.item == item)
                        .map(|s| u32::from(s.count))
                        .sum::<u32>()
                        + s.entities
                            .values()
                            .filter(|e| e.item == item)
                            .map(|e| u32::from(e.count))
                            .sum::<u32>()
                };
                assert_eq!(count(planks), 3);
                assert_eq!(count(stick), 2);
                assert_eq!(count(pickaxe), 0);
                if full {
                    assert_eq!(s.entities.len(), 5);
                    assert!(s.entities.values().all(|e| e.pos[0] == s.clients[&1].pos[0]
                        && e.pos[2] == s.clients[&1].pos[2]
                        && (e.pos[1] - s.clients[&1].pos[1]).abs() < 0.2
                        && e.pickup_delay > 0));
                } else {
                    assert!(s.entities.is_empty());
                }
                assert!(s.take_outbox().iter().any(|(_, p)| matches!(
                    S2C::decode(p),
                    Ok(S2C::Inventory {
                        screen: 0,
                        result: None,
                        ..
                    })
                )));
            }
        }
    }

    #[test]
    fn destroying_table_or_leaving_reach_returns_or_drops_contents() {
        for broken in [false, true] {
            for full in [false, true] {
                let mut s = server();
                fill(&mut s, full);
                let pos = table(&mut s);
                use_table(&mut s, pos);
                if broken {
                    s.world.set_block(pos[0], pos[1], pos[2], blocks::AIR);
                } else {
                    s.handle_packet(
                        1,
                        &C2S::Teleport {
                            x: 100.0,
                            y: 80.0,
                            z: 100.0,
                        }
                        .encode(),
                    );
                }
                s.tick();
                let inv = &s.clients[&1].inventory;
                assert_eq!(inv.screen, inventory::Screen::None);
                assert_eq!(inv.table, [None; 9]);
                assert_eq!(inv.crafting, [None; 4]);
                assert_eq!(inv.cursor, None);
                let returned = inv
                    .slots()
                    .iter()
                    .flatten()
                    .filter(|s| s.item != 1)
                    .map(|s| u32::from(s.count))
                    .sum::<u32>()
                    + s.entities.values().map(|e| u32::from(e.count)).sum::<u32>();
                assert_eq!(returned, 12);
                assert_eq!(s.entities.len(), if full { 3 } else { 0 });
                assert!(s
                    .take_outbox()
                    .iter()
                    .any(|(_, p)| matches!(S2C::decode(p), Ok(S2C::Inventory { screen: 0, .. }))));
            }
        }
    }
    fn fill(s: &mut Server, full: bool) {
        let inv = &mut s.clients.get_mut(&1).unwrap().inventory;
        *inv = Inventory::default();
        if full {
            for i in 0..36 {
                inv.set(i, Some(Stack { item: 1, count: 64 })).unwrap();
            }
        }
        inv.crafting[0] = Some(Stack { item: 8, count: 2 });
        inv.cursor = Some(Stack { item: 43, count: 3 });
        inv.table[8] = Some(Stack { item: 5, count: 7 });
    }
    #[test]
    fn close_save_disconnect_return_and_drop_overflow() {
        let mut s = server();
        fill(&mut s, false);
        s.handle_packet(1, &C2S::CloseInventory.encode());
        s.tick();
        assert_eq!(
            s.clients[&1].inventory.slots()[0],
            Some(Stack { item: 8, count: 2 })
        );
        assert_eq!(
            s.clients[&1].inventory.slots()[1],
            Some(Stack { item: 5, count: 7 })
        );
        assert_eq!(
            s.clients[&1].inventory.slots()[2],
            Some(Stack { item: 43, count: 3 })
        );
        fill(&mut s, true);
        let bytes = s.inventory_data(1).unwrap();
        assert_eq!(
            Inventory::from_bytes(&bytes).unwrap().0,
            s.clients[&1].inventory
        );
        assert!(s.entities.is_empty());
        s.handle_packet(1, &C2S::CloseInventory.encode());
        s.tick();
        assert_eq!(s.entities.len(), 3);
        assert_eq!(
            s.entities.values().map(|e| u32::from(e.count)).sum::<u32>(),
            12
        );
        fill(&mut s, true);
        s.disconnect(1);
        assert!(!s.clients.contains_key(&1));
        assert_eq!(s.entities.len(), 6);
        // The same return operation used by disconnect also inserts into non-full inventories.
        let mut inv = Inventory::default();
        inv.crafting[0] = Some(Stack { item: 8, count: 2 });
        assert!(inv.return_crafting().is_empty());
        assert_eq!(inv.slots()[0], Some(Stack { item: 8, count: 2 }));
    }
    #[test]
    fn inventory_snapshot_returns_transient_items_without_changing_live_state() {
        for full in [false, true] {
            let mut s = server();
            fill(&mut s, full);
            let before = s.clients[&1].inventory.clone();
            let hash = s.state_hash();
            let dirty = s.clients[&1].inventory_dirty;
            let (snapshot, vitals) = Inventory::from_bytes(&s.inventory_data(1).unwrap()).unwrap();
            assert_eq!(s.clients[&1].inventory, before);
            assert_eq!(s.state_hash(), hash);
            assert_eq!(s.clients[&1].inventory_dirty, dirty);
            assert!(s.entities.is_empty());
            assert_eq!(snapshot, before);
            assert_eq!(s.inventory_data(1), Some(snapshot.to_bytes(vitals)));
        }
    }
    #[test]
    fn reconnect_preserves_every_item_when_transient_stacks_do_not_fit() {
        let mut original = server();
        fill(&mut original, true);
        original
            .clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(35, Some(Stack { item: 8, count: 63 }))
            .unwrap();
        let before = original.clients[&1].inventory.clone();
        let mut expected = BTreeMap::<u16, u32>::new();
        for stack in before
            .slots()
            .iter()
            .copied()
            .chain(before.crafting)
            .chain(before.table)
            .chain([before.cursor])
            .flatten()
        {
            *expected.entry(stack.item).or_default() += u32::from(stack.count);
        }
        let bytes = original.inventory_data(1).unwrap();
        assert_eq!(original.clients[&1].inventory, before);
        let mut restored = Server::new(2026, Generator::Flat);
        let pos = [2.5, 80.0, 3.5];
        restored.connect_at(1, false, Some(pos), Some(&bytes));
        let inv = &restored.clients[&1].inventory;
        assert_eq!(inv.crafting, [None; 4]);
        assert_eq!(inv.cursor, None);
        assert_eq!(inv.slots()[35], Some(Stack { item: 8, count: 64 }));
        let mut actual = BTreeMap::<u16, u32>::new();
        for stack in inv.slots().iter().flatten() {
            *actual.entry(stack.item).or_default() += u32::from(stack.count);
        }
        for entity in restored.entities.values() {
            *actual.entry(entity.item).or_default() += u32::from(entity.count);
            assert_eq!(entity.pos, pos);
            assert_eq!(entity.velocity, [0.0, 0.1, 0.0]);
            assert_eq!(entity.pickup_delay, 40);
        }
        assert_eq!(actual, expected);
        assert_eq!(restored.entities.len(), 3);
        // A subsequent snapshot and reconnect must not restore transient items twice.
        let saved = restored.inventory_data(1).unwrap();
        let mut again = Server::new(2026, Generator::Flat);
        again.connect_at(1, false, Some(pos), Some(&saved));
        assert!(again.entities.is_empty());
        assert_eq!(again.clients[&1].inventory, restored.clients[&1].inventory);
    }
    #[test]
    fn multiplayer_release_then_reconnect_preserves_inventory_and_world_totals() {
        fn totals(s: &Server) -> BTreeMap<u16, u32> {
            let inv = &s.clients[&1].inventory;
            let mut totals = BTreeMap::new();
            for (item, count) in inv
                .slots()
                .iter()
                .copied()
                .chain(inv.crafting)
                .chain(inv.table)
                .chain([inv.cursor])
                .flatten()
                .map(|s| (s.item, s.count))
                .chain(s.entities.values().map(|e| (e.item, e.count)))
            {
                *totals.entry(item).or_default() += u32::from(count);
            }
            totals
        }
        let mut s = server();
        fill(&mut s, true);
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(35, Some(Stack { item: 8, count: 63 }))
            .unwrap();
        let before = totals(&s);
        // Same order as WorldDO: return, remember position/inventory, disconnect.
        s.return_crafting(1);
        let position = s.client_position(1);
        let saved = s.inventory_data(1).unwrap();
        let (inv, _) = Inventory::from_bytes(&saved).unwrap();
        assert_eq!(inv.crafting, [None; 4]);
        assert_eq!(inv.cursor, None);
        assert_eq!(s.entities.len(), 3);
        assert_eq!(totals(&s), before);
        s.disconnect(1);
        s.connect_at(1, true, position, Some(&saved));
        assert_eq!(totals(&s), before);
        assert_eq!(s.entities.len(), 3);
        assert_eq!(s.clients[&1].inventory, inv);
    }
    #[test]
    fn rejects_and_resends_and_hashes_transient_state_deterministically() {
        let (mut a, mut b) = (server(), server());
        fill(&mut a, false);
        fill(&mut b, false);
        assert_eq!(a.state_hash(), b.state_hash());
        b.clients.get_mut(&1).unwrap().inventory.table[0] = Some(Stack { item: 5, count: 1 });
        assert_ne!(a.state_hash(), b.state_hash());
        fill(&mut b, false);
        b.clients.get_mut(&1).unwrap().inventory.screen =
            inventory::Screen::CraftingTable { pos: [0, 80, 0] };
        assert_ne!(a.state_hash(), b.state_hash());
        let open_hash = b.state_hash();
        b.clients.get_mut(&1).unwrap().inventory.screen =
            inventory::Screen::CraftingTable { pos: [1, 80, 0] };
        assert_ne!(b.state_hash(), open_hash);
        fill(&mut b, false);
        b.clients.get_mut(&1).unwrap().inventory.cursor = None;
        assert_ne!(a.state_hash(), b.state_hash());
        fill(&mut b, false);
        for (slot, button, shift) in [
            (36, 1, false),
            (0, 0, false),
            (40, 0, true),
            (99, 0, false),
            (0, 2, false),
        ] {
            let packet = C2S::ClickSlot {
                slot,
                button,
                shift,
            }
            .encode();
            a.handle_packet(1, &packet);
            b.handle_packet(1, &packet);
            a.tick();
            b.tick();
            assert_eq!(a.state_hash(), b.state_hash());
        }
        assert_eq!(a.stats.packets_rejected, 2);
        assert!(a
            .take_outbox()
            .iter()
            .any(|(_, p)| matches!(S2C::decode(p), Ok(S2C::Inventory { .. }))));
    }
}

#[cfg(test)]
mod furnace_server_tests {
    use super::*;
    fn stack(name: &str, count: u8) -> Option<Stack> {
        Some(Stack {
            item: items::by_name(name).unwrap(),
            count,
        })
    }
    fn setup() -> (Server, [i32; 3]) {
        let mut s = Server::new(2026, Generator::Flat);
        for id in 1..=2 {
            s.connect_with_teleport(id, true);
            s.handle_packet(
                id,
                &C2S::Hello {
                    protocol: protocol::PROTOCOL_VERSION,
                    view_distance: 0,
                }
                .encode(),
            );
        }
        s.tick();
        let p = s.clients[&1].pos;
        let pos = [
            p[0].floor() as i32 + 1,
            p[1].floor() as i32,
            p[2].floor() as i32,
        ];
        s.change_block(1, pos, blocks::FURNACE, true);
        for c in s.clients.values_mut() {
            c.inventory = Inventory::default();
        }
        s.take_outbox();
        (s, pos)
    }
    fn open(s: &mut Server, id: u32, [x, y, z]: [i32; 3]) {
        s.handle_packet(id, &C2S::UseBlock { x, y, z }.encode());
        s.tick();
    }
    fn click(s: &mut Server, slot: u8, shift: bool) {
        s.handle_packet(
            1,
            &C2S::ClickSlot {
                slot,
                button: 0,
                shift,
            }
            .encode(),
        );
        s.tick();
    }
    #[test]
    fn shared_screen_routes_clicks_rejects_invalid_slots_and_closes() {
        let (mut s, pos) = setup();
        for slot in 51..=53 {
            click(&mut s, slot, false);
        }
        assert_eq!(s.stats.packets_rejected, 3);
        open(&mut s, 1, [pos[0] + 20, pos[1], pos[2]]);
        assert_eq!(s.stats.packets_rejected, 4);
        open(&mut s, 1, pos);
        open(&mut s, 1, pos);
        assert_eq!(s.stats.packets_rejected, 5);
        open(&mut s, 2, pos);
        for slot in 36..=50 {
            click(&mut s, slot, false);
        }
        assert_eq!(s.stats.packets_rejected, 20);
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(0, stack("iron_ore", 3))
            .unwrap();
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(1, stack("coal", 1))
            .unwrap();
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(2, stack("dirt", 2))
            .unwrap();
        click(&mut s, 0, true);
        s.take_outbox();
        click(&mut s, 1, true);
        let packets = s.take_outbox();
        for id in 1..=2 {
            assert!(packets.iter().any(|(to, p)| *to == id
                && matches!(
                    S2C::decode(p),
                    Ok(S2C::Inventory {
                        screen: 2,
                        burn: 1599,
                        ..
                    })
                )));
        }
        assert_eq!(s.furnaces[&pos].slots[0], stack("iron_ore", 3));
        click(&mut s, 2, true);
        assert_eq!(s.clients[&1].inventory.slots()[9], stack("dirt", 2));
        s.clients.get_mut(&1).unwrap().inventory.cursor = stack("dirt", 1);
        click(&mut s, 52, false);
        assert_eq!(s.furnaces[&pos].slots[1], None);
        click(&mut s, 53, false);
        assert_eq!(s.furnaces[&pos].slots[2], None);
        s.handle_packet(1, &C2S::CloseInventory.encode());
        s.tick();
        assert_eq!(s.furnaces[&pos].slots[0], stack("iron_ore", 3));
        assert_eq!(s.clients[&1].inventory.cursor, None);
        s.clients.get_mut(&2).unwrap().pos[0] += 30.0;
        s.tick();
        assert_eq!(s.clients[&2].inventory.screen, inventory::Screen::None);
        // Validate before clicking, too.
        s.clients.get_mut(&1).unwrap().inventory.screen = inventory::Screen::Furnace { pos };
        s.clients.get_mut(&1).unwrap().pos[0] += 30.0;
        let before = s.furnaces[&pos].slots;
        click(&mut s, 51, true);
        assert_eq!(s.furnaces[&pos].slots, before);
        assert_eq!(s.clients[&1].inventory.screen, inventory::Screen::None);
    }
    #[test]
    fn opens_furnace_without_a_saved_entry_as_empty() {
        for empty_tail in [false, true] {
            let (mut s, pos) = setup();
            let c = (pos[0] >> 4, pos[2] >> 4);
            let mut bytes = s.world.chunks[&c].to_bytes();
            if empty_tail {
                bytes.push(0);
            }
            s.world.remove_chunk(c.0, c.1);
            s.furnaces.clear();
            assert!(s.load_chunk(c.0, c.1, &bytes));
            assert_eq!(
                s.world.get_block(pos[0], pos[1], pos[2]),
                Some(blocks::FURNACE)
            );
            s.tick();
            assert!(!s.furnaces.contains_key(&pos));

            open(&mut s, 1, pos);
            assert_eq!(
                s.clients[&1].inventory.screen,
                inventory::Screen::Furnace { pos }
            );
            assert_eq!(s.furnaces[&pos], furnace::Furnace::default());
            s.clients
                .get_mut(&1)
                .unwrap()
                .inventory
                .set(0, stack("iron_ore", 3))
                .unwrap();
            click(&mut s, 0, true);
            assert_eq!(s.furnaces[&pos].slots[0], stack("iron_ore", 3));
        }
    }
    #[test]
    fn burning_furnace_outside_keep_range_pauses_unloads_and_resumes() {
        let (mut s, pos) = setup();
        let (cx, cz) = (pos[0] >> 4, pos[2] >> 4);
        assert!(s
            .clients
            .values()
            .all(|c| c.inventory.screen == inventory::Screen::None));
        s.furnaces.get_mut(&pos).unwrap().slots = [stack("iron_ore", 3), stack("coal", 1), None];
        for _ in 0..30 {
            s.tick();
        }
        let paused = s.furnaces[&pos].clone();
        assert!(paused.burn > 0 && paused.progress > 0);

        let center = pos.map(|coord| f64::from(coord) + 0.5);
        for c in s.clients.values_mut() {
            let far_cx = cx + c.view + UNLOAD_MARGIN + 1;
            c.pos = [f64::from(far_cx * 16) + 0.5, center[1], center[2]];
        }
        for _ in 0..10 {
            s.tick();
        }
        assert_eq!(s.furnaces[&pos], paused);
        assert!(s.world.chunks[&(cx, cz)].dirty);
        s.unload_far_chunks();
        assert!(s.world.chunks.contains_key(&(cx, cz)));

        let bytes = loop {
            let (x, z, bytes) = s.take_dirty().unwrap();
            if (x, z) == (cx, cz) {
                break bytes;
            }
        };
        s.unload_far_chunks();
        assert!(!s.world.chunks.contains_key(&(cx, cz)));
        assert!(!s.furnaces.contains_key(&pos));

        assert!(s.load_chunk(cx, cz, &bytes));
        assert_eq!(s.furnaces[&pos], paused);
        s.tick();
        assert_eq!(s.furnaces[&pos], paused);
        assert!(!s.world.chunks[&(cx, cz)].dirty);

        for c in s.clients.values_mut() {
            c.pos = center;
        }
        let mut resumed = paused.clone();
        resumed.tick();
        s.tick();
        assert_eq!(s.furnaces[&pos], resumed);
    }
    #[test]
    fn persists_unopened_furnaces_and_rejects_corrupt_tails() {
        let (mut s, pos) = setup();
        s.furnaces.get_mut(&pos).unwrap().slots = [stack("iron_ore", 3), stack("coal", 1), None];
        for _ in 0..213 {
            s.tick();
        }
        let f = s.furnaces[&pos].clone();
        assert_eq!(f.slots[2], stack("iron_ingot", 1));
        assert_eq!(f.progress, 53);
        let hash = s.state_hash();
        s.furnaces.get_mut(&pos).unwrap().progress += 1;
        assert_ne!(s.state_hash(), hash);
        s.furnaces.insert(pos, f.clone());
        let c = (pos[0] >> 4, pos[2] >> 4);
        let bytes = loop {
            let (x, z, b) = s.take_dirty().unwrap();
            if (x, z) == c {
                break b;
            }
        };
        let prefix = s.world.chunks[&c].to_bytes();
        assert!(Chunk::read(c.0, c.1, &mut Reader::new(&prefix)).is_ok());
        s.clients.clear();
        s.unload_far_chunks();
        assert!(!s.furnaces.contains_key(&pos));
        assert!(s.load_chunk(c.0, c.1, &bytes));
        assert_eq!(s.furnaces[&pos], f);
        s.world.remove_chunk(c.0, c.1);
        s.furnaces.clear();
        assert!(s.load_chunk(c.0, c.1, &prefix));
        assert!(!s.furnaces.contains_key(&pos));
        let old_end = prefix.len() + 1 + 25;
        let old = Server::read_saved_chunk(c.0, c.1, &bytes[..old_end]).unwrap();
        assert_eq!(old.furnaces[&pos], f);
        assert!(old.scheduled_blocks.is_empty());
        for end in (prefix.len() + 1..old_end).chain(old_end + 1..bytes.len()) {
            assert!(Server::read_saved_chunk(c.0, c.1, &bytes[..end]).is_err());
        }
        for (offset, value) in [(0, 2), (1, 16), (6, 16), (7, 255), (9, 0)] {
            let mut bad = bytes.clone();
            bad[prefix.len() + offset] = value;
            assert!(
                Server::read_saved_chunk(c.0, c.1, &bad).is_err(),
                "offset {offset}"
            );
        }
        let mut bad = bytes.clone();
        bad.push(0);
        assert!(Server::read_saved_chunk(c.0, c.1, &bad).is_err());
        let mut bad = bytes.clone();
        bad[prefix.len() + 1] = (pos[0] + 1).rem_euclid(16) as u8;
        assert!(Server::read_saved_chunk(c.0, c.1, &bad).is_err());
    }
    #[test]
    fn wooden_pickaxe_mines_coal_instead_of_the_ore() {
        let (mut s, pos) = setup();
        s.set_game_mode(GameMode::Survival);
        s.change_block(1, pos, blocks::COAL_ORE, false);
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(0, stack("wooden_pickaxe", 1))
            .unwrap();
        s.handle_packet(
            1,
            &C2S::DigStart {
                x: pos[0],
                y: pos[1],
                z: pos[2],
            }
            .encode(),
        );
        let (ticks, drops) =
            items::mining(blocks::COAL_ORE, items::by_name("wooden_pickaxe")).unwrap();
        assert!(drops);
        for _ in 0..=ticks {
            s.tick();
        }
        assert_eq!(s.get_block(pos[0], pos[1], pos[2]), Some(blocks::AIR));
        assert!(s
            .entities
            .values()
            .any(|e| Some(e.item) == items::by_name("coal")));
        assert!(!s
            .entities
            .values()
            .any(|e| Some(e.item) == items::by_name("coal_ore")));
    }
    #[test]
    fn destruction_drops_contents_in_both_modes() {
        for mode in [GameMode::Survival, GameMode::Creative] {
            let (mut s, pos) = setup();
            s.set_game_mode(mode);
            s.furnaces.get_mut(&pos).unwrap().slots = [
                stack("iron_ore", 3),
                stack("coal", 1),
                stack("iron_ingot", 2),
            ];
            s.change_block(1, pos, blocks::AIR, false);
            assert!(!s.furnaces.contains_key(&pos));
            let mut contents: Vec<_> = s.entities.values().map(|e| (e.item, e.count)).collect();
            contents.sort();
            let mut expected: Vec<_> = [
                stack("iron_ore", 3),
                stack("coal", 1),
                stack("iron_ingot", 2),
            ]
            .into_iter()
            .flatten()
            .map(|s| (s.item, s.count))
            .collect();
            expected.sort();
            assert_eq!(contents, expected);
        }
    }
}
