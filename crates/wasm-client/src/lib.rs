//! C ABI for the client side: a mirror of the chunks the server has sent,
//! packet encoding/decoding, section meshing and block ray casts.
//!
//! Same conventions as `wasm-server`: no imports, byte results go to an
//! internal buffer (`client_out_ptr`), mesh vertices to a second one
//! (`client_mesh_ptr`).

use std::cell::UnsafeCell;
use std::collections::{BTreeMap, BTreeSet};

use mesher::{padded_index, PADDED_LEN};
use protocol::{C2S, PROTOCOL_VERSION, S2C};
use world::biomes::BIOMES;
use world::io::Reader;
use world::{blocks, Chunk, World, HEIGHT, MIN_Y, SECTIONS};
use worldgen::{Generator, TerrainGenerator};

/// Stand-in for blocks of chunks that have not arrived yet: treated as solid
/// so no faces are built against the unknown, then re-meshed on arrival.
const UNKNOWN: u16 = blocks::STONE;

struct State {
    world: World,
    connectivity: BTreeMap<world::visibility::Key, u16>,
    connectivity_work: world::visibility::Connectivity,
    connectivity_grid: Vec<u16>,
    visibility: world::visibility::Search,
    visibility_stale: bool,
    visibility_camera: Option<world::visibility::Key>,
    culling: bool,
    visibility_all: bool,
    visible_keys: Vec<world::visibility::Key>,
    visible_next: Vec<world::visibility::Key>,
    visibility_changed: bool,
    /// Sections whose mesh is stale: (chunk x, section index, chunk z).
    dirty: BTreeSet<(i32, i32, i32)>,
    unloaded: Vec<(i32, i32)>,
    light_pending: BTreeSet<(i32, i32)>,
    external_light: bool,
    light_generations: BTreeMap<(i32, i32), (u32, u32)>,
    light_exports: Option<BTreeSet<(i32, usize, i32)>>,
    seed: i64,
    spawn: [f64; 3],
    view_distance: u32,
    game_time: i64,
    day_time: i64,
    out: Vec<u8>,
    padded: Vec<u16>,
    padded_lights: Vec<u8>,
    player: physics::Player,
    flying: bool,
}

struct Global(UnsafeCell<Option<State>>);
// SAFETY: a WebAssembly instance without threads is only ever entered from one thread.
unsafe impl Sync for Global {}
static STATE: Global = Global(UnsafeCell::new(None));

struct TintState {
    terrain: Option<(i64, TerrainGenerator)>,
    out: [u8; 16],
}
struct TintGlobal(UnsafeCell<TintState>);
// SAFETY: each WebAssembly instance is entered by only one thread.
unsafe impl Sync for TintGlobal {}
static TINT: TintGlobal = TintGlobal(UnsafeCell::new(TintState {
    terrain: None,
    out: [0; 16],
}));

// A biome ID is one byte in the tint worker ABI, including ID 255.
const _: () = assert!(BIOMES.len() <= u8::MAX as usize + 1);

/// Writes grass RGB, leaves RGB, water RGB for each biome ID to client_out_ptr.
/// Requires client_new; the result remains valid until the next client out write.
#[no_mangle]
pub extern "C" fn client_biome_colors() -> usize {
    let out = &mut state().out;
    out.clear();
    for biome in BIOMES {
        out.extend_from_slice(&biome.grass_color);
        out.extend_from_slice(&biome.leaves_color);
        out.extend_from_slice(&biome.water_color);
    }
    out.len()
}

/// Writes sixteen cell biome IDs to tint_out_ptr without requiring client_new.
/// Keeps the last seed's prepared terrain generator across calls.
#[no_mangle]
pub extern "C" fn tint_biome_cells(seed: i64, generator: u32, cx: i32, cz: i32) -> usize {
    // SAFETY: single-threaded; no exported function re-enters another.
    let tint = unsafe { &mut *TINT.0.get() };
    let cells = if Generator::from_id(generator) == Generator::Terrain {
        if tint.terrain.as_ref().map(|(cached_seed, _)| *cached_seed) != Some(seed) {
            tint.terrain = Some((seed, TerrainGenerator::new(seed)));
        }
        tint.terrain.as_ref().unwrap().1.biome_cells(cx, cz)
    } else {
        [0; 16]
    };
    tint.out = cells.map(|id| u8::try_from(id).expect("biome ID must fit in u8"));
    tint.out.len()
}

/// Last tint_biome_cells result; valid until the next tint_biome_cells call.
#[no_mangle]
pub extern "C" fn tint_out_ptr() -> *const u8 {
    // SAFETY: single-threaded, as for TINT writes.
    unsafe { (&*TINT.0.get()).out.as_ptr() }
}

struct MeshOutput(UnsafeCell<Vec<u32>>);
// SAFETY: each instance is entered by only one thread.
unsafe impl Sync for MeshOutput {}
struct MeshCounts(UnsafeCell<[u32; 3]>);
// SAFETY: each instance is entered by only one thread.
unsafe impl Sync for MeshCounts {}
static MESH_COUNTS: MeshCounts = MeshCounts(UnsafeCell::new([0; 3]));

/// Quad count for opaque (0), cutout (1), or translucent (2), from the last mesh call.
#[no_mangle]
pub extern "C" fn client_mesh_count(layer: usize) -> u32 {
    unsafe { (*MESH_COUNTS.0.get()).get(layer).copied().unwrap_or(0) }
}

static MESH_OUTPUT: MeshOutput = MeshOutput(UnsafeCell::new(Vec::new()));

#[allow(clippy::mut_from_ref)]
fn state() -> &'static mut State {
    // SAFETY: single-threaded, and no exported function re-enters another.
    unsafe {
        (*STATE.0.get())
            .as_mut()
            .expect("client_new must be called first")
    }
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

#[no_mangle]
pub extern "C" fn mc_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `mc_alloc(len)` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn mc_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn client_new() {
    let st = State {
        world: World::with_lighting(true),
        connectivity: BTreeMap::new(),
        connectivity_work: Default::default(),
        connectivity_grid: Vec::new(),
        visibility: Default::default(),
        visibility_stale: true,
        visibility_camera: None,
        culling: true,
        visibility_all: true,
        visible_keys: Vec::new(),
        visible_next: Vec::new(),
        visibility_changed: true,
        dirty: BTreeSet::new(),
        unloaded: Vec::new(),
        light_pending: BTreeSet::new(),
        external_light: false,
        light_generations: BTreeMap::new(),
        light_exports: None,
        seed: 0,
        spawn: [0.0; 3],
        view_distance: 0,
        game_time: 0,
        day_time: 0,
        out: Vec::new(),
        padded: vec![blocks::AIR; PADDED_LEN],
        padded_lights: Vec::new(),
        player: physics::Player::default(),
        flying: true,
    };
    let mut st = st;
    st.world.track_light_changes();
    // SAFETY: single-threaded.
    unsafe { *STATE.0.get() = Some(st) };
}

/// Discards the mirror and queues all old chunk meshes for removal.
#[no_mangle]
pub extern "C" fn client_reset_world() {
    let st = state();
    if st.light_exports.is_none() {
        st.unloaded.extend(st.world.chunks.keys().copied());
    }
    st.connectivity.clear();
    st.visibility_stale = true;
    st.world.chunks.clear();
    st.dirty.clear();
    st.light_pending.clear();
    st.light_generations.clear();
    if let Some(exports) = &mut st.light_exports {
        exports.clear();
    }
    st.world.take_light_changes().for_each(drop);
}

#[no_mangle]
pub extern "C" fn client_out_ptr() -> *const u8 {
    state().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn client_mesh_ptr() -> *const u32 {
    unsafe { (&*MESH_OUTPUT.0.get()).as_ptr() }
}

fn mark_chunk_dirty(st: &mut State, cx: i32, cz: i32) {
    if st.light_exports.is_some() {
        return;
    }
    if let Some(chunk) = st.world.chunks.get(&(cx, cz)) {
        for (i, section) in chunk.sections.iter().enumerate() {
            if !section.is_empty() {
                st.dirty.insert((cx, i as i32, cz));
            }
        }
    }
}

/// Handles one server packet. Returns the packet id, or 0xFFFF_FFFF when the
/// packet was malformed and ignored.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn client_packet(ptr: *const u8, len: usize) -> u32 {
    let bytes = input(ptr, len);
    let st = state();
    let Ok(packet) = S2C::decode(bytes) else {
        return u32::MAX;
    };
    match packet {
        S2C::Welcome {
            seed,
            game_time,
            spawn,
            view_distance,
        } => {
            st.seed = seed;
            st.game_time = game_time;
            st.spawn = spawn;
            st.view_distance = view_distance as u32;
        }
        S2C::PlayerCorrect { x, y, z } => {
            st.player = physics::Player::new([x, y, z]);
        }
        S2C::ChunkData { cx, cz, data } => {
            let Ok(chunk) = Chunk::read(cx, cz, &mut Reader::new(&data)) else {
                return u32::MAX;
            };
            invalidate_connectivity(st, cx, cz);
            st.light_generations.remove(&(cx, cz));
            if st.external_light {
                st.world.chunks.insert((cx, cz), chunk);
            } else {
                st.world.insert_chunk_unlit(chunk);
            }
            st.light_pending.insert((cx, cz));
            mark_chunk_dirty(st, cx, cz);
            // Border faces of the neighbours can now be culled.
            for (dx, dz) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                mark_chunk_dirty(st, cx + dx, cz + dz);
            }
        }
        S2C::UnloadChunk { cx, cz } => {
            invalidate_connectivity(st, cx, cz);
            st.light_pending.remove(&(cx, cz));
            st.light_generations.remove(&(cx, cz));
            let removed = if st.external_light {
                st.world.chunks.remove(&(cx, cz))
            } else {
                st.world.remove_chunk(cx, cz)
            };
            if removed.is_some() {
                if st.light_exports.is_none() {
                    st.unloaded.push((cx, cz));
                }
                // Border faces and derived stair/fence connections now see
                // an absent neighbor. mark_chunk_dirty skips light exporters.
                for (dx, dz) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                    mark_chunk_dirty(st, cx + dx, cz + dz);
                }
            }
        }
        S2C::BlockUpdate {
            x,
            y,
            z,
            state: block,
        } => {
            set_block(st, x, y, z, block);
        }
        S2C::TimeUpdate {
            game_time,
            day_time,
        } => {
            st.game_time = game_time;
            st.day_time = day_time;
        }
    }
    mark_light_dirty(st);
    bytes[0] as u32
}

fn set_block(st: &mut State, x: i32, y: i32, z: i32, block: u16) -> bool {
    if !blocks::is_valid(block) {
        return false;
    }
    let old = if st.external_light {
        st.world
            .chunks
            .get_mut(&(x >> 4, z >> 4))
            .and_then(|c| c.set((x & 15) as usize, y, (z & 15) as usize, block))
    } else {
        st.world.set_block(x, y, z, block)
    };
    match old {
        Some(old) if old != block => {
            if let Some(sy) = world::section_index(y) {
                st.connectivity.remove(&(x >> 4, sy as i32, z >> 4));
                st.visibility_stale = true;
            }
            // Faces, AO and derived stair/fence connections of touching blocks
            // may change. Shapes only query cardinal neighbors, so this one-cell
            // radius also covers their dependencies across section boundaries.
            if st.light_exports.is_none() {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        for dx in -1..=1 {
                            let (nx, ny, nz) = (x + dx, y + dy, z + dz);
                            if let Some(s) = world::section_index(ny) {
                                st.dirty.insert((nx >> 4, s as i32, nz >> 4));
                            }
                        }
                    }
                }
            }
            mark_light_dirty(st);
            true
        }
        _ => false,
    }
}

/// Applies a block change locally before the server confirms it.
#[no_mangle]
pub extern "C" fn client_predict_block(x: i32, y: i32, z: i32, block: u32) -> u32 {
    set_block(state(), x, y, z, block as u16) as u32
}

#[no_mangle]
pub extern "C" fn client_seed() -> i64 {
    state().seed
}

#[no_mangle]
pub extern "C" fn client_spawn(axis: u32) -> f64 {
    state().spawn[(axis as usize).min(2)]
}

#[no_mangle]
pub extern "C" fn client_view_distance() -> u32 {
    state().view_distance
}

#[no_mangle]
pub extern "C" fn client_game_time() -> i64 {
    state().game_time
}

#[no_mangle]
pub extern "C" fn client_day_time() -> i64 {
    state().day_time
}

#[no_mangle]
pub extern "C" fn client_chunk_count() -> u32 {
    state().world.chunks.len() as u32
}

#[no_mangle]
pub extern "C" fn client_dirty_count() -> u32 {
    let st = state();
    st.dirty.iter().filter(|&&k| is_visible(st, k)).count() as u32
}

fn invalidate_connectivity(st: &mut State, cx: i32, cz: i32) {
    for sy in 0..SECTIONS as i32 {
        st.connectivity.remove(&(cx, sy, cz));
    }
    st.visibility_stale = true;
}
fn is_visible(st: &State, key: world::visibility::Key) -> bool {
    st.visibility_all || st.visibility.contains(key)
}
#[no_mangle]
pub extern "C" fn client_hidden_dirty_count() -> u32 {
    let st = state();
    st.dirty.iter().filter(|&&k| !is_visible(st, k)).count() as u32
}
/// Called once per host frame before mesh scheduling. Output only changes when
/// the loaded visible set changes: -1 unchanged, -2 all visible, otherwise count.
#[no_mangle]
pub extern "C" fn client_update_visibility(x: f64, y: f64, z: f64, enabled: u32) -> i32 {
    let st = state();
    let camera = (
        (x.floor() as i32) >> 4,
        ((y.floor() as i32) - MIN_Y) >> 4,
        (z.floor() as i32) >> 4,
    );
    let culling = enabled != 0;
    if !st.visibility_stale && st.visibility_camera == Some(camera) && st.culling == culling {
        return -1;
    }
    st.visibility_stale = false;
    st.visibility_camera = Some(camera);
    st.culling = culling;
    let all = !culling || !(0..SECTIONS as i32).contains(&camera.1);
    if !all {
        let r = st.view_distance as i32;
        let bounds = [camera.0 - r, camera.0 + r, camera.2 - r, camera.2 + r];
        // Scan the ordered cache once into reusable dense storage. BFS then
        // avoids tree lookups for every entry face of every loaded section.
        let width = bounds[1] - bounds[0] + 1;
        let index = |key: world::visibility::Key| {
            (((key.2 - bounds[2]) * width + key.0 - bounds[0]) as usize) * SECTIONS + key.1 as usize
        };
        st.connectivity_grid.clear();
        st.connectivity_grid
            .resize((width * width) as usize * SECTIONS, u16::MAX);
        for (&key, &value) in &st.connectivity {
            if (bounds[0]..=bounds[1]).contains(&key.0) && (bounds[2]..=bounds[3]).contains(&key.2)
            {
                st.connectivity_grid[index(key)] = value;
            }
        }
        let grid = &mut st.connectivity_grid;
        let world = &st.world;
        let cache = &mut st.connectivity;
        let work = &mut st.connectivity_work;
        st.visibility.run(camera, bounds, |key| {
            let i = index(key);
            if grid[i] != u16::MAX {
                return grid[i];
            }
            let value = if let Some(chunk) = world.chunks.get(&(key.0, key.2)) {
                let value = work.compute(&chunk.sections[key.1 as usize]);
                cache.insert(key, value);
                value
            } else {
                world::visibility::ALL
            };
            grid[i] = value;
            value
        });
    }
    st.visible_next.clear();
    for &(cx, cz) in st.world.chunks.keys() {
        for sy in 0..SECTIONS as i32 {
            let key = (cx, sy, cz);
            if all || st.visibility.contains(key) {
                st.visible_next.push(key);
            }
        }
    }
    let changed =
        st.visibility_changed || st.visibility_all != all || st.visible_next != st.visible_keys;
    std::mem::swap(&mut st.visible_keys, &mut st.visible_next);
    st.visibility_all = all;
    st.visibility_changed = false;
    if !changed {
        return -1;
    }
    if all {
        return -2;
    }
    st.out.clear();
    for &(cx, sy, cz) in &st.visible_keys {
        for v in [cx, sy, cz] {
            st.out.extend_from_slice(&v.to_le_bytes());
        }
    }
    st.visible_keys.len() as i32
}
#[no_mangle]
pub extern "C" fn client_visible_count() -> u32 {
    state().visible_keys.len() as u32
}

fn mark_light_dirty(st: &mut State) {
    let changes: Vec<_> = st.world.take_light_changes().collect();
    if let Some(exports) = &mut st.light_exports {
        exports.extend(changes);
        return;
    }
    for (cx, sy, cz) in changes {
        dirty_light_section(st, cx, sy, cz);
    }
}
fn dirty_light_section(st: &mut State, cx: i32, sy: usize, cz: i32) {
    if st.light_exports.is_some() {
        return;
    }
    for dz in -1..=1 {
        for dx in -1..=1 {
            for dy in -1..=1 {
                let s = sy as i32 + dy;
                if (0..SECTIONS as i32).contains(&s)
                    && st
                        .world
                        .chunks
                        .get(&(cx + dx, cz + dz))
                        .is_some_and(|c| !c.sections[s as usize].is_empty())
                {
                    st.dirty.insert((cx + dx, s, cz + dz));
                }
            }
        }
    }
}
/// External mode never runs initial or incremental lighting on this instance.
/// Switching back invalidates derived data and queues a budgeted rebuild.
#[no_mangle]
pub extern "C" fn client_external_light(enabled: u32) {
    let st = state();
    st.external_light = enabled != 0;
    st.light_pending.extend(st.world.chunks.keys().copied());
    for chunk in st.world.chunks.values_mut() {
        chunk.lighting = None;
    }
    for value in st.light_generations.values_mut() {
        value.1 = 0;
    }
    st.world.take_light_changes().for_each(drop);
}
#[no_mangle]
pub extern "C" fn client_light_generation(cx: i32, cz: i32, generation: u32) {
    state().light_generations.insert((cx, cz), (generation, 0));
}
#[no_mangle]
pub extern "C" fn client_light_export_mode() {
    let st = state();
    st.light_exports = Some(Default::default());
    // This instance only produces light updates; it has no renderer to drain these.
    st.dirty.clear();
    st.unloaded.clear();
}

// Wire record: cx, sy, cz, generation (four LE u32s), then 2048 sky
// and 2048 block packed nibble bytes. One batch can contain many chunks.
pub const LIGHT_RECORD_BYTES: usize = 16 + 4096;
fn write_nibbles(out: &mut Vec<u8>, values: &world::light::Nibbles) {
    match values {
        world::light::Nibbles::Uniform(v) => out.resize(out.len() + 2048, v * 17),
        world::light::Nibbles::Packed(a) => out.extend_from_slice(a.as_ref()),
    }
}
fn read_nibbles(bytes: &[u8]) -> world::light::Nibbles {
    let v = bytes[0] & 15;
    if bytes.iter().all(|&b| b == v * 17) {
        world::light::Nibbles::Uniform(v)
    } else {
        world::light::Nibbles::Packed(Box::new(bytes.try_into().unwrap()))
    }
}
#[no_mangle]
pub extern "C" fn client_take_light_updates() -> usize {
    let st = state();
    st.out.clear();
    let changes = st
        .light_exports
        .as_mut()
        .map(std::mem::take)
        .unwrap_or_default();
    for (cx, sy, cz) in changes {
        let Some(c) = st.world.chunks.get(&(cx, cz)) else {
            continue;
        };
        let Some(light) = &c.lighting else { continue };
        let Some(&(generation, _)) = st.light_generations.get(&(cx, cz)) else {
            continue;
        };
        for value in [cx as u32, sy as u32, cz as u32, generation] {
            st.out.extend_from_slice(&value.to_le_bytes());
        }
        write_nibbles(&mut st.out, &light.sections[sy].sky);
        write_nibbles(&mut st.out, &light.sections[sy].block);
    }
    st.out.len()
}
/// # Safety
/// ptr..ptr+len must be readable; input must not alias the client state.
#[no_mangle]
pub unsafe extern "C" fn client_apply_light_updates(ptr: *const u8, len: usize) -> usize {
    let bytes = input(ptr, len);
    if !len.is_multiple_of(LIGHT_RECORD_BYTES) {
        return 0;
    }
    let st = state();
    if !st.external_light {
        return 0;
    }
    let mut changes = Vec::new();
    for record in bytes.as_chunks::<LIGHT_RECORD_BYTES>().0 {
        let word = |i| u32::from_le_bytes(record[i..i + 4].try_into().unwrap());
        let (cx, sy, cz, generation) = (word(0) as i32, word(4) as usize, word(8) as i32, word(12));
        if sy >= SECTIONS {
            continue;
        }
        let Some(value) = st.light_generations.get_mut(&(cx, cz)) else {
            continue;
        };
        if value.0 != generation {
            continue;
        }
        let Some(chunk) = st.world.chunks.get_mut(&(cx, cz)) else {
            continue;
        };
        let light = chunk.lighting.get_or_insert_with(Default::default);
        light.sections[sy] = world::light::LightSection {
            sky: read_nibbles(&record[16..2064]),
            block: read_nibbles(&record[2064..]),
        };
        value.1 |= 1 << sy;
        if value.1 == (1 << SECTIONS) - 1 {
            st.light_pending.remove(&(cx, cz));
        }
        changes.push((cx, sy, cz));
    }
    let count = changes.len();
    // Reuse the same conservative mesh invalidation as locally computed light.
    for (cx, sy, cz) in changes {
        dirty_light_section(st, cx, sy, cz);
    }
    count
}

fn light_ready(st: &State, cx: i32, cz: i32) -> bool {
    (-1..=1).all(|dz| (-1..=1).all(|dx| !st.light_pending.contains(&(cx + dx, cz + dz))))
}
#[no_mangle]
pub extern "C" fn client_light_pending() -> usize {
    state().light_pending.len()
}
/// Process one nearest chunk. The host checks its clock between calls, so a
/// single chunk may overrun the frame deadline, but no second chunk starts.
#[no_mangle]
pub extern "C" fn client_light_step(cam_x: f64, cam_z: f64) -> u32 {
    let st = state();
    if st.external_light {
        return 0;
    }
    let distance = |&(x, z): &(i32, i32)| {
        let dx = (x * 16 + 8) as f64 - cam_x;
        let dz = (z * 16 + 8) as f64 - cam_z;
        dx * dx + dz * dz
    };
    let Some(key) = st
        .light_pending
        .iter()
        .min_by(|a, b| distance(a).total_cmp(&distance(b)))
        .copied()
    else {
        return 0;
    };
    st.light_pending.remove(&key);
    st.world.light_chunk(key.0, key.1);
    mark_light_dirty(st);
    1
}

/// Picks the stale section nearest to the camera. Output: `[cx][sy][cz]` as
/// i32 LE. Returns 0 when nothing is stale.
#[no_mangle]
pub extern "C" fn client_pop_dirty(cam_x: f64, cam_y: f64, cam_z: f64) -> u32 {
    let st = state();
    let world = &st.world;
    st.dirty
        .retain(|&(cx, _, cz)| world.chunks.contains_key(&(cx, cz)));
    let mut best: Option<(f64, (i32, i32, i32))> = None;
    for &key in &st.dirty {
        let (cx, sy, cz) = key;
        if !is_visible(st, key) || !light_ready(st, cx, cz) {
            continue;
        }
        let dx = (cx * 16 + 8) as f64 - cam_x;
        let dy = (MIN_Y + sy * 16 + 8) as f64 - cam_y;
        let dz = (cz * 16 + 8) as f64 - cam_z;
        let d = dx * dx + dy * dy + dz * dz;
        if best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, key));
        }
    }
    let Some((_, key)) = best else { return 0 };
    st.dirty.remove(&key);
    st.out.clear();
    for v in [key.0, key.1, key.2] {
        st.out.extend_from_slice(&v.to_le_bytes());
    }
    1
}

/// Requeues work if a worker fails after taking it from the dirty set.
#[no_mangle]
pub extern "C" fn client_requeue_dirty(cx: i32, sy: i32, cz: i32) {
    let st = state();
    if st.light_exports.is_none() {
        st.dirty.insert((cx, sy, cz));
    }
}

#[no_mangle]
pub extern "C" fn client_is_dirty(cx: i32, sy: i32, cz: i32) -> u32 {
    let st = state();
    if !light_ready(st, cx, cz) {
        // A discarded result must be rebuilt after lighting arrives, even if
        // its section is now empty and light invalidation would skip it.
        if st.light_exports.is_none() && st.world.chunks.contains_key(&(cx, cz)) {
            st.dirty.insert((cx, sy, cz));
        }
        return 1;
    }
    st.dirty.contains(&(cx, sy, cz)) as u32
}

/// Copies the section and its border into the padded buffer; returns u16 count.
#[no_mangle]
pub extern "C" fn client_padded(cx: i32, sy: i32, cz: i32) -> usize {
    let st = state();
    if !(0..SECTIONS as i32).contains(&sy) {
        return 0;
    }
    let Some(center) = st.world.chunks.get(&(cx, cz)) else {
        return 0;
    };
    if center.sections[sy as usize].is_empty() {
        return 0;
    }

    // The 3x3 chunk columns around the section, fetched once.
    let mut columns: [Option<&Chunk>; 9] = [None; 9];
    for dz in -1..=1 {
        for dx in -1..=1 {
            columns[((dz + 1) * 3 + dx + 1) as usize] = st.world.chunks.get(&(cx + dx, cz + dz));
        }
    }
    let base_y = MIN_Y + sy * 16;
    for y in -1..=16 {
        let wy = base_y + y;
        let in_world = (MIN_Y..MIN_Y + HEIGHT).contains(&wy);
        for z in -1..=16i32 {
            for x in -1..=16i32 {
                let column = columns[(((z >> 4) + 1) * 3 + (x >> 4) + 1) as usize];
                let block = if !in_world {
                    blocks::AIR
                } else {
                    match column {
                        Some(c) => c.get((x & 15) as usize, wy, (z & 15) as usize),
                        None => UNKNOWN,
                    }
                };
                st.padded[padded_index(x, y, z)] = block;
            }
        }
    }
    PADDED_LEN
}

#[no_mangle]
pub extern "C" fn client_padded_ptr() -> *const u16 {
    state().padded.as_ptr()
}

/// Copies 18³ sky/block levels (one byte each) in `padded_index` order.
/// Returns 0 while lighting is disabled. Otherwise missing chunks and below-world
/// cells are dark; above the world sky is 15.
#[no_mangle]
pub extern "C" fn client_padded_light(cx: i32, sy: i32, cz: i32) -> usize {
    let st = state();
    if !st.world.lighting_enabled()
        || !(0..SECTIONS as i32).contains(&sy)
        || !st.world.chunks.contains_key(&(cx, cz))
    {
        return 0;
    }
    st.padded_lights.resize(PADDED_LEN * 2, 0);
    let columns: [Option<&world::light::ChunkLighting>; 9] = std::array::from_fn(|i| {
        st.world
            .chunks
            .get(&(cx + i as i32 % 3 - 1, cz + i as i32 / 3 - 1))
            .and_then(|c| c.lighting.as_deref())
    });
    for y in -1..=16 {
        let wy = MIN_Y + sy * 16 + y;
        for z in -1..=16i32 {
            for x in -1..=16i32 {
                let i = padded_index(x, y, z);
                let light = columns[(((z >> 4) + 1) * 3 + (x >> 4) + 1) as usize];
                let (sky, block) = if let (Some(s), Some(light)) = (world::section_index(wy), light)
                {
                    let idx = world::Section::index(
                        (x & 15) as usize,
                        (wy & 15) as usize,
                        (z & 15) as usize,
                    );
                    (
                        light.sections[s].sky.get(idx),
                        light.sections[s].block.get(idx),
                    )
                } else {
                    ((wy >= MIN_Y + HEIGHT) as u8 * 15, 0)
                };
                st.padded_lights[i] = sky;
                st.padded_lights[PADDED_LEN + i] = block;
            }
        }
    }
    PADDED_LEN
}
#[no_mangle]
pub extern "C" fn client_padded_sky_ptr() -> *const u8 {
    state().padded_lights.as_ptr()
}
#[no_mangle]
pub extern "C" fn client_padded_block_ptr() -> *const u8 {
    state().padded_lights.as_ptr().wrapping_add(PADDED_LEN)
}

/// Meshes padded u16 block data without requiring client_new or a world.
/// Invalid lengths produce an empty mesh, like an empty section.
///
/// # Safety
/// For PADDED_LEN elements, ptr must point to that many readable, aligned u16s.
/// If both light pointers are non-null, each must contain PADDED_LEN readable bytes
/// with levels in 0..=15. A null light pointer selects the daylight fallback.
#[no_mangle]
pub unsafe extern "C" fn mesh_padded(
    ptr: *const u16,
    len: usize,
    sky: *const u8,
    block: *const u8,
) -> u32 {
    let mesh = &mut *MESH_OUTPUT.0.get();
    mesh.clear();
    *MESH_COUNTS.0.get() = [0; 3];
    if len != PADDED_LEN {
        return 0;
    }
    let light = if sky.is_null() || block.is_null() {
        None
    } else {
        Some((
            std::slice::from_raw_parts(sky, PADDED_LEN),
            std::slice::from_raw_parts(block, PADDED_LEN),
        ))
    };
    let counts = mesher::mesh_section_layers(std::slice::from_raw_parts(ptr, len), light, mesh);
    *MESH_COUNTS.0.get() = counts;
    counts.iter().sum()
}

/// Meshes one section into the mesh buffer and returns the quad count.
#[no_mangle]
pub extern "C" fn client_mesh(cx: i32, sy: i32, cz: i32) -> u32 {
    let len = client_padded(cx, sy, cz);
    // SAFETY: the padded buffer remains valid throughout the call.
    let lights = client_padded_light(cx, sy, cz);
    let (sky, block) = if lights == PADDED_LEN {
        (client_padded_sky_ptr(), client_padded_block_ptr())
    } else {
        (std::ptr::null(), std::ptr::null())
    };
    unsafe { mesh_padded(client_padded_ptr(), len, sky, block) }
}

/// Output: repeated `[cx i32 LE][cz i32 LE]` of chunks removed since the last call.
#[no_mangle]
pub extern "C" fn client_take_unloaded() -> usize {
    let st = state();
    st.out.clear();
    for (cx, cz) in st.unloaded.drain(..) {
        st.out.extend_from_slice(&cx.to_le_bytes());
        st.out.extend_from_slice(&cz.to_le_bytes());
    }
    st.out.len()
}

/// Block at a position; 0xFFFF_FFFF when the chunk is not loaded.
#[no_mangle]
pub extern "C" fn client_get_block(x: i32, y: i32, z: i32) -> u32 {
    state()
        .world
        .get_block(x, y, z)
        .map_or(u32::MAX, |b| b as u32)
}

/// Walks the grid and intersects selection boxes, including non-solid plants.
/// Output: x/y/z/face, local min/max XYZ in sixteenths (ten i32 LE),
/// then the intersection local Y as f64 LE (0..=1, including the top edge).
#[no_mangle]
pub extern "C" fn client_raycast(
    ox: f64,
    oy: f64,
    oz: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    max: f64,
) -> u32 {
    let st = state();
    let origin = [ox, oy, oz];
    let dir = [dx, dy, dz];
    if dir.iter().all(|d| *d == 0.0) || !origin.iter().chain(dir.iter()).all(|v| v.is_finite()) {
        return 0;
    }
    let mut cell = [ox.floor() as i32, oy.floor() as i32, oz.floor() as i32];
    let mut step = [0i32; 3];
    let mut t_max = [f64::INFINITY; 3];
    let mut t_delta = [f64::INFINITY; 3];
    for a in 0..3 {
        if dir[a] > 0.0 {
            step[a] = 1;
            t_delta[a] = 1.0 / dir[a];
            t_max[a] = ((cell[a] + 1) as f64 - origin[a]) / dir[a];
        } else if dir[a] < 0.0 {
            step[a] = -1;
            t_delta[a] = -1.0 / dir[a];
            t_max[a] = (cell[a] as f64 - origin[a]) / dir[a];
        }
    }
    loop {
        if let Some(b) = st.world.get_block(cell[0], cell[1], cell[2]) {
            let boxes = blocks::selection_boxes(b, |dx, dy, dz| {
                st.world
                    .get_block(cell[0] + dx, cell[1] + dy, cell[2] + dz)
                    .unwrap_or(blocks::AIR)
            });
            let hit = boxes
                .iter()
                .filter_map(|bounds| {
                    physics::ray_box(
                        origin,
                        dir,
                        physics::shape_box(*bounds, cell[0], cell[1], cell[2]),
                    )
                    .filter(|(t, _)| *t <= max)
                    .map(|(t, face)| (t, face, bounds))
                })
                .min_by(|a, b| a.0.total_cmp(&b.0));
            if let Some((distance, face, bounds)) = hit {
                st.out.clear();
                for v in [cell[0], cell[1], cell[2], face]
                    .into_iter()
                    .chain(bounds.min.map(i32::from))
                    .chain(bounds.max.map(i32::from))
                {
                    st.out.extend_from_slice(&v.to_le_bytes());
                }
                st.out
                    .extend_from_slice(&(oy + distance * dy - cell[1] as f64).to_le_bytes());
                return 1;
            }
        }
        let a = if t_max[0] <= t_max[1] && t_max[0] <= t_max[2] {
            0
        } else if t_max[1] <= t_max[2] {
            1
        } else {
            2
        };
        if t_max[a] > max {
            return 0;
        }
        cell[a] += step[a];
        t_max[a] += t_delta[a];
    }
}

fn emit(st: &mut State, bytes: Vec<u8>) -> usize {
    st.out = bytes;
    st.out.len()
}

#[no_mangle]
pub extern "C" fn client_enc_hello(view_distance: u32) -> usize {
    let p = C2S::Hello {
        protocol: PROTOCOL_VERSION,
        view_distance: view_distance.min(255) as u8,
    };
    emit(state(), p.encode())
}

#[no_mangle]
pub extern "C" fn client_enc_pos(x: f64, y: f64, z: f64, yaw: f32, pitch: f32) -> usize {
    emit(
        state(),
        C2S::PlayerPos {
            x,
            y,
            z,
            yaw,
            pitch,
        }
        .encode(),
    )
}

#[no_mangle]
pub extern "C" fn client_enc_teleport(x: f64, y: f64, z: f64) -> usize {
    emit(state(), C2S::Teleport { x, y, z }.encode())
}

/// Authoritative feet position, including the most recent correction.
#[no_mangle]
pub extern "C" fn client_player_position(axis: usize) -> f64 {
    state().player.position[axis.min(2)]
}

#[no_mangle]
pub extern "C" fn client_enc_set_block(x: i32, y: i32, z: i32, block: u32) -> usize {
    emit(
        state(),
        C2S::SetBlock {
            x,
            y,
            z,
            state: block.min(u16::MAX as u32) as u16,
        }
        .encode(),
    )
}

/// Output: newline-separated texture names in atlas layer order.
#[no_mangle]
pub extern "C" fn client_texture_names() -> usize {
    emit(state(), blocks::TEXTURES.join("\n").into_bytes())
}

/// Output: newline-separated block names, line number = block id.
#[no_mangle]
pub extern "C" fn client_block_names() -> usize {
    let names: Vec<&str> = (0..blocks::COUNT).map(|b| blocks::info(b).name).collect();
    emit(state(), names.join("\n").into_bytes())
}

/// JSON state metadata, indexed by state ID. Block defaults and textures come
/// from the same registry used by meshing, collisions and server validation.
#[no_mangle]
pub extern "C" fn client_block_registry() -> usize {
    let entries: Vec<_> = (0..blocks::COUNT).map(|state| {
        let info = blocks::info(state);
        let block = blocks::block(state).unwrap();
        let model = match info.model {
            blocks::Model::Cube => "cube",
            blocks::Model::Boxes(_) => "boxes",
            blocks::Model::Cross => "cross",
            blocks::Model::Stairs => "stairs",
            blocks::Model::Fence => "fence",
        };
        format!(r#"{{"name":"{}","stateName":"{}","first":{},"count":{},"model":"{}","occludes":{},"texture":"{}"}}"#,
            block.name, blocks::state_name(state), block.first, block.count, model,
            info.occludes, blocks::TEXTURES[info.tex[1] as usize])
    }).collect();
    emit(state(), format!("[{}]", entries.join(",")).into_bytes())
}

/// Reset prediction after spawn or a debug camera teleport. Coordinates are feet.
#[no_mangle]
pub extern "C" fn client_player_reset(x: f64, y: f64, z: f64) {
    let st = state();
    st.player = physics::Player::new([x, y, z]);
    st.flying = true;
}

struct Collisions<'a>(&'a World);
impl physics::CollisionWorld for Collisions<'_> {
    fn collision_boxes(&self, x: i32, y: i32, z: i32, visit: &mut dyn FnMut(physics::Aabb)) {
        physics::BlockWorld(|x, y, z| self.0.get_block(x, y, z)).collision_boxes(x, y, z, visit);
    }
}

/// Toggle only when the player can safely start walking. A debug teleport or
/// a placed block may leave the player inside terrain; flight lets them escape.
#[no_mangle]
pub extern "C" fn client_player_toggle_flight() -> u32 {
    let st = state();
    if !st.flying || st.player.is_clear(&Collisions(&st.world)) {
        st.flying = !st.flying;
    }
    u32::from(st.flying)
}

/// One 50ms tick. Flags: jump=1, sprint=2, sneak=4. Output is six f64 LE
/// values (feet xyz, velocity xyz), followed by on_ground and flying as u8.
#[no_mangle]
pub extern "C" fn client_player_tick(forward: f32, strafe: f32, yaw: f32, flags: u32) {
    let st = state();
    st.player.tick(
        physics::Input {
            forward,
            strafe,
            yaw,
            jump: flags & 1 != 0,
            sprint: flags & 2 != 0,
            sneak: flags & 4 != 0,
            flying: st.flying,
        },
        &Collisions(&st.world),
    );
    st.out.clear();
    for v in st.player.position.into_iter().chain(st.player.velocity) {
        st.out.extend_from_slice(&v.to_le_bytes());
    }
    st.out.push(u8::from(st.player.on_ground));
    st.out.push(u8::from(st.flying));
}

#[cfg(test)]
mod tests {
    use super::*;

    static CLIENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn receive(chunk: &Chunk) {
        let packet = S2C::ChunkData {
            cx: chunk.cx,
            cz: chunk.cz,
            data: chunk.to_bytes(),
        }
        .encode();
        assert_ne!(
            unsafe { client_packet(packet.as_ptr(), packet.len()) },
            u32::MAX
        );
    }

    #[test]
    fn visibility_crosses_missing_chunks_and_refreshes_replacements_and_unloads() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        state().world.set_lighting_enabled(false);
        state().view_distance = 2;
        receive(&Chunk::empty(0, 0));
        let mut far = Chunk::empty(2, 0);
        far.sections.fill(world::Section::uniform(blocks::STONE));
        receive(&far);
        client_update_visibility(8.0, 8.0, 8.0, 1);
        assert!(is_visible(state(), (2, 4, 0)));
        assert_eq!(state().connectivity[&(2, 4, 0)], 0);
        assert!(!state().connectivity.contains_key(&(1, 4, 0)));
        far.sections.fill(world::Section::uniform(blocks::GLASS));
        receive(&far);
        assert!(!state().connectivity.contains_key(&(2, 4, 0)));
        client_update_visibility(8.0, 8.0, 8.0, 1);
        assert_eq!(state().connectivity[&(2, 4, 0)], world::visibility::ALL);
        let unload = S2C::UnloadChunk { cx: 2, cz: 0 }.encode();
        unsafe {
            client_packet(unload.as_ptr(), unload.len());
        }
        assert!(!state().connectivity.contains_key(&(2, 4, 0)));
        assert!(state().visibility_stale);
        client_update_visibility(8.0, 8.0, 8.0, 1);
        assert!(!state().visible_keys.contains(&(2, 4, 0)));
        assert_eq!(client_visible_count(), SECTIONS as u32);
    }

    #[test]
    fn cached_visibility_timing() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        state().world.set_lighting_enabled(false);
        state().view_distance = 12;
        for z in -12..=12 {
            for x in -12..=12 {
                state().world.chunks.insert((x, z), Chunk::empty(x, z));
            }
        }
        client_update_visibility(8.0, 100.0, 8.0, 1);
        let start = std::time::Instant::now();
        for i in 0..30 {
            state().visibility_stale = true;
            std::hint::black_box(client_update_visibility(8.0, 100.0, 8.0, 1));
            assert_eq!(client_visible_count(), 15000, "run {i}");
        }
        eprintln!(
            "cached client visibility: 15000 sections, {:?}/run (30 runs)",
            start.elapsed() / 30
        );
    }

    #[test]
    fn visibility_keeps_hidden_meshes_dirty_and_invalidates_only_edited_section() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        state().world.set_lighting_enabled(false);
        state().view_distance = 1;
        for cz in -1..=1 {
            for cx in -1..=1 {
                let mut chunk = Chunk::empty(cx, cz);
                chunk.sections[2] = world::Section::uniform(blocks::STONE);
                chunk.sections[1].set(8, 8, 8, blocks::STONE);
                receive(&chunk);
            }
        }
        state().light_pending.clear();
        let camera_y = (MIN_Y + 3 * 16 + 8) as f64;
        assert!(client_update_visibility(8.0, camera_y, 8.0, 1) >= 0);
        assert!(client_hidden_dirty_count() > 0);
        let count = client_dirty_count();
        for _ in 0..count {
            assert_eq!(client_pop_dirty(8.0, camera_y, 8.0), 1);
            let sy = i32::from_le_bytes(state().out[4..8].try_into().unwrap());
            assert_ne!(sy, 1);
        }
        assert_eq!(client_dirty_count(), 0);
        assert_eq!(client_pop_dirty(8.0, camera_y, 8.0), 0);
        assert_eq!(client_update_visibility(8.0, camera_y, 8.0, 1), -1);
        assert!(state().connectivity.contains_key(&(0, 2, 0)));
        for y in MIN_Y + 32..MIN_Y + 48 {
            client_predict_block(8, y, 8, blocks::AIR as u32);
        }
        assert!(!state().connectivity.contains_key(&(0, 2, 0)));
        assert!(state().connectivity.contains_key(&(1, 2, 0)));
        client_update_visibility(8.0, camera_y, 8.0, 1);
        assert!(is_visible(state(), (0, 1, 0)));
        let mut found = false;
        while client_pop_dirty(8.0, camera_y, 8.0) != 0 {
            let sy = i32::from_le_bytes(state().out[4..8].try_into().unwrap());
            found |= sy == 1;
        }
        assert!(found);
        client_update_visibility(8.0, camera_y, 8.0, 0);
        assert_eq!(client_hidden_dirty_count(), 0);
        assert_eq!(client_dirty_count() as usize, state().dirty.len());
        assert_eq!(client_update_visibility(8.0, 400.0, 8.0, 1), -1); // Already unrestricted.
        assert!(state().visibility_all);
        client_reset_world();
        assert!(state().connectivity.is_empty());
    }

    #[test]
    fn biome_colors_are_rgb_triples_in_registry_order() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        let len = client_biome_colors();
        assert_eq!(len, BIOMES.len() * 9);
        let bytes = unsafe { std::slice::from_raw_parts(client_out_ptr(), len) };
        for (id, biome) in BIOMES.iter().enumerate() {
            assert_eq!(&bytes[id * 9..id * 9 + 3], biome.grass_color);
            assert_eq!(&bytes[id * 9 + 3..id * 9 + 6], biome.leaves_color);
            assert_eq!(&bytes[id * 9 + 6..id * 9 + 9], biome.water_color);
        }
    }

    #[test]
    fn tint_cells_work_without_world_and_match_worldgen() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        // Explicitly discard any world left by other tests to exercise Worker startup.
        unsafe { *STATE.0.get() = None };
        assert!(BIOMES.len() <= u8::MAX as usize + 1);
        for seed in [2026, -71, 2026] {
            for (cx, cz) in [(0, 0), (-3, -1), (32, -64)] {
                assert_eq!(tint_biome_cells(seed, 2, cx, cz), 16);
                let cells = unsafe { std::slice::from_raw_parts(tint_out_ptr(), 16) };
                for (index, &id) in cells.iter().enumerate() {
                    assert_eq!(
                        u16::from(id),
                        worldgen::biome_at(
                            Generator::Terrain,
                            seed,
                            cx * 16 + (index % 4) as i32 * 4 + 2,
                            cz * 16 + (index / 4) as i32 * 4 + 2,
                        )
                    );
                }
            }
            for generator in [0, 1, 3, u32::MAX] {
                assert_eq!(tint_biome_cells(seed, generator, -1, 2), 16);
                assert_eq!(
                    unsafe { std::slice::from_raw_parts(tint_out_ptr(), 16) },
                    [0; 16]
                );
            }
        }
        assert!(unsafe { (&*STATE.0.get()).is_none() });
    }

    #[test]
    fn unloading_neighbor_requeues_boundary_fence_mesh_except_in_light_export_mode() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        for (external_light, export_mode) in [(false, false), (true, false), (false, true)] {
            for (cx, cz, ax, az, bx, bz) in [
                (1, 0, 15, 8, 0, 8),
                (-1, 0, 0, 8, 15, 8),
                (0, 1, 8, 15, 8, 0),
                (0, -1, 8, 0, 8, 15),
            ] {
                client_new();
                // Isolate geometry invalidation from lighting changes.
                state().world.set_lighting_enabled(false);
                client_external_light(u32::from(external_light));
                if export_mode {
                    client_light_export_mode();
                }
                let mut a = Chunk::empty(0, 0);
                a.set(ax, 80, az, blocks::OAK_FENCE);
                let mut b = Chunk::empty(cx, cz);
                b.set(bx, 80, bz, blocks::STONE);
                receive(&a);
                receive(&b);
                assert_eq!(client_mesh(0, 9, 0), 16); // Post and two connected rails.
                state().dirty.clear();

                let packet = S2C::UnloadChunk { cx, cz }.encode();
                assert_ne!(
                    unsafe { client_packet(packet.as_ptr(), packet.len()) },
                    u32::MAX
                );

                assert!(!state().world.chunks.contains_key(&(cx, cz)));
                assert_eq!(state().dirty.contains(&(0, 9, 0)), !export_mode);
                if export_mode {
                    assert!(state().dirty.is_empty());
                    assert!(state().unloaded.is_empty());
                }
            }
        }
    }

    #[test]
    fn selection_ray_hits_slab_and_plant_bounds_and_skips_empty_space() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        state().world.set_lighting_enabled(false);
        state().world.insert_chunk(Chunk::empty(0, 0));
        for (block, y, expected) in [
            (blocks::OAK_SLAB, 80.25, [0, 0, 0, 16, 8, 16]),
            (blocks::OAK_SLAB + 1, 80.75, [0, 8, 0, 16, 16, 16]),
            (blocks::RED_FLOWER, 80.25, [5, 0, 5, 11, 10, 11]),
        ] {
            state().world.set_block(2, 80, 2, block);
            assert_eq!(client_raycast(1.5, y, 2.5, 1.0, 0.0, 0.0, 6.0), 1);
            let hit: Vec<_> = state().out[..40]
                .chunks(4)
                .map(|v| i32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            assert_eq!(&hit[..4], &[2, 80, 2, 4]);
            assert_eq!(&hit[4..], &expected);
            assert_eq!(
                f64::from_le_bytes(state().out[40..48].try_into().unwrap()),
                y - 80.0
            );
            assert_eq!(
                client_raycast(
                    1.5,
                    if y < 80.5 { 80.9 } else { 80.1 },
                    2.5,
                    1.0,
                    0.0,
                    0.0,
                    6.0
                ),
                0
            );
        }
        state().world.set_block(2, 80, 2, blocks::OAK_SLAB);
        assert_eq!(client_raycast(2.5, 82.0, 2.5, 0.0, -1.0, 0.0, 6.0), 1);
        assert_eq!(
            i32::from_le_bytes(state().out[12..16].try_into().unwrap()),
            1
        );
        assert_eq!(
            f64::from_le_bytes(state().out[40..48].try_into().unwrap()),
            0.5
        );
        state().world.set_block(2, -2, 2, blocks::OAK_SLAB + 1);
        assert_eq!(client_raycast(1.5, -1.25, 2.5, 1.0, 0.0, 0.0, 6.0), 1);
        assert_eq!(
            f64::from_le_bytes(state().out[40..48].try_into().unwrap()),
            0.75
        );
    }

    #[test]
    fn raycast_and_selection_follow_neighbor_changes_for_stairs_and_fences() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        state().world.set_lighting_enabled(false);
        state().world.insert_chunk(Chunk::empty(0, 0));
        state().world.set_block(2, 80, 2, blocks::OAK_STAIRS);
        assert_eq!(client_raycast(2.75, 82.0, 2.25, 0.0, -1.0, 0.0, 6.0), 1);
        let hit_y = || f64::from_le_bytes(state().out[40..48].try_into().unwrap());
        assert_eq!(hit_y(), 1.0);
        state()
            .world
            .set_block(2, 80, 1, blocks::COBBLESTONE_STAIRS + 4);
        // The outer corner removes the east upper quarter, exposing the slab.
        assert_eq!(client_raycast(2.75, 82.0, 2.25, 0.0, -1.0, 0.0, 6.0), 1);
        assert_eq!(hit_y(), 0.5);
        assert_eq!(client_raycast(2.25, 82.0, 2.25, 0.0, -1.0, 0.0, 6.0), 1);
        assert_eq!(hit_y(), 1.0);
        assert_eq!(
            i32::from_le_bytes(state().out[28..32].try_into().unwrap()),
            8
        ); // selected quarter max x
        state().world.set_block(2, 80, 1, blocks::AIR);
        assert_eq!(client_raycast(2.75, 82.0, 2.25, 0.0, -1.0, 0.0, 6.0), 1);
        assert_eq!(hit_y(), 1.0);
        state().world.set_block(2, 80, 2, blocks::OAK_FENCE);
        assert_eq!(client_raycast(2.8, 82.0, 2.5, 0.0, -1.0, 0.0, 3.0), 0);
        state().world.set_block(3, 80, 2, blocks::STONE);
        assert_eq!(client_raycast(2.8, 82.0, 2.5, 0.0, -1.0, 0.0, 3.0), 1);
        assert_eq!(hit_y(), 1.0);
        assert_eq!(
            i32::from_le_bytes(state().out[32..36].try_into().unwrap()),
            16
        ); // selection height, not collision height
        state().world.set_block(3, 80, 2, blocks::AIR);
        assert_eq!(client_raycast(2.8, 82.0, 2.5, 0.0, -1.0, 0.0, 3.0), 0);
    }

    #[test]
    fn neighbor_edits_dirty_connected_shape_across_section_boundaries() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        for shape in [blocks::OAK_STAIRS, blocks::OAK_FENCE] {
            client_new();
            state().world.set_lighting_enabled(false);
            state().world.insert_chunk(Chunk::empty(0, 0));
            state().world.insert_chunk(Chunk::empty(1, 0));
            state().world.set_block(15, 80, 2, shape);
            state().dirty.clear();
            assert!(set_block(state(), 16, 80, 2, blocks::STONE));
            assert!(state().dirty.contains(&(0, 9, 0)));
            assert!(state().dirty.contains(&(1, 9, 0)));
        }
    }

    #[test]
    fn prediction_uses_registry_boxes_for_steps_clearance_and_plants() {
        let _guard = CLIENT_LOCK.lock().unwrap();
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
            client_new();
            state().world.set_lighting_enabled(false);
            let mut chunk = Chunk::empty(0, 0);
            for x in 0..16 {
                for z in 0..16 {
                    chunk.set(
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
            chunk.set(1, if roof { 65 } else { 64 }, 1, obstacle);
            state().world.insert_chunk(chunk);
            let floor = if roof { 63.5 } else { 64.0 };
            client_player_reset(0.5, floor, 1.5);
            assert_eq!(client_player_toggle_flight(), 0);
            let mut highest = floor;
            for _ in 0..18 {
                client_player_tick(0.0, -1.0, 0.0, 0);
                highest = highest.max(state().player.position[1]);
                assert!(state().player.is_clear(&Collisions(&state().world)));
            }
            assert_eq!(
                state().player.position[0] > 1.0,
                passes,
                "state {obstacle}, roof {roof}"
            );
            if obstacle == blocks::OAK_FENCE {
                assert!(state().player.position[0] < 1.1);
            }
            if obstacle == blocks::OAK_SLAB && !roof {
                assert_eq!(highest, 64.5);
            }
        }
    }

    #[test]
    fn material_collisions_raycast_and_mesh_abi() {
        use physics::CollisionWorld;
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        state().world.set_lighting_enabled(false);
        state().world.insert_chunk(Chunk::empty(0, 0));
        for material in [blocks::WATER, blocks::GLASS, blocks::OAK_LEAVES] {
            state().world.set_block(2, 80, 2, material);
            state().world.set_block(3, 80, 2, blocks::STONE);
            let mut collision = None;
            Collisions(&state().world).collision_boxes(2, 80, 2, &mut |b| collision = Some(b));
            assert_eq!(collision.is_some(), material != blocks::WATER);
            assert_eq!(client_raycast(1.5, 80.5, 2.5, 1.0, 0.0, 0.0, 6.0), 1);
            let hit_x = i32::from_le_bytes(state().out[..4].try_into().unwrap());
            assert_eq!(hit_x, if material == blocks::WATER { 3 } else { 2 });
        }
        state().world.insert_chunk(Chunk::empty(0, 0));
        for (x, material) in [
            (2, blocks::STONE),
            (5, blocks::GLASS),
            (8, blocks::WATER),
            (11, blocks::OAK_LEAVES),
            (12, blocks::OAK_LEAVES),
        ] {
            state().world.set_block(x, 80, 3, material);
        }
        assert_eq!(client_mesh(0, 9, 0), 28);
        assert_eq!(
            [
                client_mesh_count(0),
                client_mesh_count(1),
                client_mesh_count(2)
            ],
            [6, 16, 6]
        );
        let mut p = vec![blocks::AIR; PADDED_LEN];
        for (x, material) in [
            (2, blocks::STONE),
            (5, blocks::GLASS),
            (8, blocks::WATER),
            (11, blocks::OAK_LEAVES),
            (12, blocks::OAK_LEAVES),
        ] {
            p[padded_index(x, 3, 3)] = material;
        }
        assert_eq!(
            unsafe { mesh_padded(p.as_ptr(), p.len(), std::ptr::null(), std::ptr::null()) },
            28
        );
        assert_eq!(
            [
                client_mesh_count(0),
                client_mesh_count(1),
                client_mesh_count(2)
            ],
            [6, 16, 6]
        );
        assert_eq!(
            unsafe { mesh_padded(p.as_ptr(), 0, std::ptr::null(), std::ptr::null()) },
            0
        );
        assert_eq!(
            [
                client_mesh_count(0),
                client_mesh_count(1),
                client_mesh_count(2)
            ],
            [0; 3]
        );
    }

    #[test]
    fn light_wait_requeues_empty_sections_but_not_unloaded_chunks() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        for unload in [false, true] {
            client_new();
            let mut chunk = Chunk::empty(0, 0);
            chunk.set(8, 8, 8, blocks::STONE);
            receive(&chunk);
            assert_eq!(client_light_step(0.0, 0.0), 1);
            while client_pop_dirty(8.0, 8.0, 8.0) != 0 {}

            assert_eq!(client_predict_block(8, 8, 8, blocks::AIR as u32), 1);
            assert!(state().world.chunks[&(0, 0)].sections[4].is_empty());
            assert_eq!(client_pop_dirty(8.0, 8.0, 8.0), 1);
            let section: Vec<_> = state()
                .out
                .as_chunks::<4>()
                .0
                .iter()
                .map(|word| i32::from_le_bytes(*word))
                .collect();
            assert_eq!(section, vec![0, 4, 0]);
            assert_eq!(client_mesh(0, 4, 0), 0);

            // This arrives while the empty mesh result is in flight. Neither
            // arrival nor lighting invalidation marks an empty section dirty.
            receive(&Chunk::empty(1, 0));
            assert!(!state().dirty.contains(&(0, 4, 0)));
            if unload {
                let packet = S2C::UnloadChunk { cx: 0, cz: 0 }.encode();
                unsafe {
                    client_packet(packet.as_ptr(), packet.len());
                }
            }
            assert_eq!(client_is_dirty(0, 4, 0), 1);
            assert_eq!(state().dirty.contains(&(0, 4, 0)), !unload);
            assert_eq!(client_pop_dirty(8.0, 8.0, 8.0), 0);
            assert_eq!(client_light_step(0.0, 0.0), 1);
            assert_eq!(client_light_pending(), 0);
            assert_eq!(client_pop_dirty(8.0, 8.0, 8.0), u32::from(!unload));
            if !unload {
                let section: Vec<_> = state()
                    .out
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|word| i32::from_le_bytes(*word))
                    .collect();
                assert_eq!(section, vec![0, 4, 0]);
                assert_eq!(client_mesh(0, 4, 0), 0);
            }
            assert_eq!(client_pop_dirty(8.0, 8.0, 8.0), 0);
        }
    }

    #[test]
    fn light_export_mode_never_retains_render_work() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        // Enabling export mode also discards any previously queued render work.
        let mut chunk = Chunk::empty(0, 0);
        chunk.set(8, 0, 8, blocks::STONE);
        receive(&chunk);
        client_reset_world();
        assert!(!state().unloaded.is_empty());
        receive(&chunk);
        assert!(!state().dirty.is_empty());
        client_light_export_mode();
        client_reset_world();

        let assert_no_render_work = || {
            assert!(state().dirty.is_empty());
            assert!(state().unloaded.is_empty());
        };
        assert_no_render_work();
        for generation in 1..=8 {
            receive(&chunk);
            client_light_generation(0, 0, generation);
            assert_eq!(client_light_pending(), 1);
            assert_eq!(client_is_dirty(0, 4, 0), 1);
            assert_no_render_work();
            assert_eq!(client_predict_block(8, 0, 8, blocks::LAMP_BLOCK as u32), 1);
            assert_no_render_work();
            assert_eq!(client_light_step(0.0, 0.0), 1);
            assert_eq!(client_light_pending(), 0);
            assert_eq!(state().world.block_light(9, 0, 8), 14);
            assert_eq!(client_take_light_updates(), SECTIONS * LIGHT_RECORD_BYTES);
            assert_eq!(client_take_light_updates(), 0);
            assert_no_render_work();

            client_requeue_dirty(0, 4, 0);
            dirty_light_section(state(), 0, 4, 0);
            assert_no_render_work();
            let edit = S2C::BlockUpdate {
                x: 8,
                y: 0,
                z: 8,
                state: blocks::AIR,
            }
            .encode();
            unsafe {
                client_packet(edit.as_ptr(), edit.len());
            }
            assert_eq!(state().world.block_light(9, 0, 8), 0);
            assert!(client_take_light_updates() > 0);
            assert_no_render_work();

            let unload = S2C::UnloadChunk { cx: 0, cz: 0 }.encode();
            unsafe {
                client_packet(unload.as_ptr(), unload.len());
            }
            assert_eq!(client_light_pending(), 0);
            assert_no_render_work();
            receive(&chunk);
            client_light_generation(0, 0, generation + 8);
            assert_eq!(client_light_step(0.0, 0.0), 1);
            assert!(client_take_light_updates() > 0);
            assert_no_render_work();
            client_reset_world();
            assert_eq!(client_light_pending(), 0);
            assert_eq!(client_take_light_updates(), 0);
            assert!(state().world.chunks.is_empty());
            assert_no_render_work();
        }

        // Normal clients still queue meshes and removals for their renderer.
        client_new();
        receive(&chunk);
        assert!(!state().dirty.is_empty());
        let unload = S2C::UnloadChunk { cx: 0, cz: 0 }.encode();
        unsafe {
            client_packet(unload.as_ptr(), unload.len());
        }
        assert_eq!(state().unloaded, vec![(0, 0)]);
        receive(&chunk);
        client_reset_world();
        assert_eq!(state().unloaded, vec![(0, 0), (0, 0)]);
    }

    #[test]
    fn external_light_matches_computed_world_and_rejects_old_generations() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        client_light_export_mode();
        let mut left = Chunk::empty(-1, 0);
        left.set(15, 0, 8, blocks::LAMP_BLOCK);
        let mut center = Chunk::empty(0, 0);
        for x in 0..16 {
            for z in 0..16 {
                center.set(x, 1, z, blocks::STONE);
            }
        }
        for (c, generation) in [(&left, 7), (&center, 8)] {
            receive(c);
            client_light_generation(c.cx, c.cz, generation);
        }
        while client_light_step(0.0, 0.0) != 0 {}
        let expected: BTreeMap<_, _> = state()
            .world
            .chunks
            .iter()
            .map(|(key, c)| (*key, c.lighting.clone().unwrap()))
            .collect();
        let len = client_take_light_updates();
        let updates = state().out[..len].to_vec();
        assert_eq!(len, 2 * SECTIONS * LIGHT_RECORD_BYTES);
        client_new();
        client_external_light(1);
        for (c, generation) in [(&left, 7), (&center, 8)] {
            receive(c);
            client_light_generation(c.cx, c.cz, generation);
        }
        assert_eq!(client_light_step(0.0, 0.0), 0);
        assert!(state().world.chunks.values().all(|c| c.lighting.is_none()));
        assert_eq!(client_light_pending(), 2);
        assert_eq!(
            unsafe { client_apply_light_updates(updates.as_ptr(), updates.len()) },
            2 * SECTIONS
        );
        assert_eq!(client_light_pending(), 0);
        for (key, light) in &expected {
            assert_eq!(
                state().world.chunks[key]
                    .lighting
                    .as_ref()
                    .unwrap()
                    .sections,
                light.sections
            );
        }
        assert_eq!(client_is_dirty(0, 4, 0), 1);
        // A replacement must receive all of its own sections before becoming ready.
        receive(&center);
        client_light_generation(0, 0, 9);
        let old_center: Vec<_> = updates
            .as_chunks::<LIGHT_RECORD_BYTES>()
            .0
            .iter()
            .filter(|r| i32::from_le_bytes(r[0..4].try_into().unwrap()) == 0)
            .flatten()
            .copied()
            .collect();
        assert_eq!(
            unsafe { client_apply_light_updates(old_center.as_ptr(), old_center.len()) },
            0
        );
        assert!(state().world.chunks[&(0, 0)].lighting.is_none());
        assert_eq!(client_light_pending(), 1);
        let unload = S2C::UnloadChunk { cx: -1, cz: 0 }.encode();
        unsafe {
            client_packet(unload.as_ptr(), unload.len());
        }
        assert_eq!(
            unsafe { client_apply_light_updates(updates.as_ptr(), updates.len()) },
            0
        );
        // Editing externally supplied light never starts incremental lighting.
        assert_eq!(client_predict_block(0, 0, 8, blocks::LAMP_BLOCK as u32), 1);
        assert!(state().world.chunks[&(0, 0)].lighting.is_none());
        client_external_light(0);
        assert_eq!(client_light_pending(), 1);
        assert_eq!(client_light_step(0.0, 0.0), 1);
        assert_eq!(state().world.block_light(0, 0, 8), 15);
    }

    #[test]
    fn deferred_chunks_match_rebuild_and_edits_dirty_neighbors() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        let mut left = Chunk::empty(0, 0);
        left.set(15, 0, 8, blocks::LAMP_BLOCK);
        let mut right = Chunk::empty(1, 0);
        right.set(0, 0, 7, blocks::STONE);
        receive(&right);
        receive(&left);
        assert_eq!(client_light_pending(), 2);
        assert!(state().world.chunks.values().all(|c| c.lighting.is_none()));
        assert_eq!(client_pop_dirty(0.0, 0.0, 0.0), 0);
        assert_eq!(client_light_step(0.0, 0.0), 1);
        assert!(state().world.chunks[&(0, 0)].lighting.is_some());
        assert_eq!(client_light_pending(), 1);
        assert_eq!(client_pop_dirty(0.0, 0.0, 0.0), 0);
        assert_eq!(client_light_step(0.0, 0.0), 1);
        assert_eq!(client_light_step(0.0, 0.0), 0);
        let mut rebuilt = World::with_lighting(true);
        rebuilt.insert_chunk(right);
        rebuilt.insert_chunk(left);
        for (key, chunk) in &state().world.chunks {
            assert_eq!(chunk.lighting, rebuilt.chunks[key].lighting);
        }
        state().dirty.clear();
        assert_eq!(client_predict_block(15, 0, 8, blocks::AIR as u32), 1);
        assert_eq!(state().world.block_light(16, 0, 8), 0);
        assert_eq!(client_is_dirty(1, 4, 0), 1);
        assert_eq!(client_is_dirty(0, 4, 0), 1);
        state().dirty.clear();
        let packet = S2C::BlockUpdate {
            x: 15,
            y: 0,
            z: 8,
            state: blocks::LAMP_BLOCK,
        }
        .encode();
        unsafe {
            client_packet(packet.as_ptr(), packet.len());
        }
        assert_eq!(state().world.block_light(16, 0, 8), 14);
        assert_eq!(client_is_dirty(1, 4, 0), 1);
        client_reset_world();
        assert_eq!(client_light_pending(), 0);
    }

    #[test]
    fn padded_lighting_includes_neighbors_and_vertical_limits() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        assert!(state().world.lighting_enabled());
        state().world.set_lighting_enabled(false);
        assert_eq!(client_padded_light(0, 0, 0), 0);
        assert_eq!(state().padded_lights.capacity(), 0);
        state().world.set_lighting_enabled(true);
        let mut left = Chunk::empty(-1, 0);
        left.set(15, MIN_Y + 15, 8, blocks::LAMP_BLOCK);
        // Exercise the same decoding and insertion path as a real mirror.
        for c in [Chunk::empty(0, 0), left] {
            let packet = S2C::ChunkData {
                cx: c.cx,
                cz: c.cz,
                data: c.to_bytes(),
            }
            .encode();
            assert_ne!(
                unsafe { client_packet(packet.as_ptr(), packet.len()) },
                u32::MAX
            );
        }
        while client_light_step(0.0, 0.0) != 0 {}
        assert_eq!(client_padded_light(0, 0, 0), PADDED_LEN);
        let sky = unsafe { std::slice::from_raw_parts(client_padded_sky_ptr(), PADDED_LEN) };
        let block = unsafe { std::slice::from_raw_parts(client_padded_block_ptr(), PADDED_LEN) };
        for y in -1..=16 {
            for z in -1..=16 {
                for x in -1..=16 {
                    let i = padded_index(x, y, z);
                    assert_eq!(sky[i], state().world.sky_light(x, MIN_Y + y, z));
                    assert_eq!(block[i], state().world.block_light(x, MIN_Y + y, z));
                }
            }
        }
        assert_eq!(block[padded_index(-1, 15, 8)], 15);
        assert_eq!(block[padded_index(0, 15, 8)], 14);
        assert_eq!(block[padded_index(0, 16, 8)], 13);
        assert_eq!(sky[padded_index(0, -1, 8)], 0);
        assert_eq!(sky[padded_index(16, 0, 8)], 0);
        assert_eq!(client_padded_light(0, SECTIONS as i32 - 1, 0), PADDED_LEN);
        assert_eq!(state().padded_lights[padded_index(0, 16, 8)], 15);
        assert_eq!(client_padded_light(0, -1, 0), 0);
        assert_eq!(client_padded_light(1, 0, 0), 0);
        assert_eq!(
            client_predict_block(-1, MIN_Y + 15, 8, blocks::AIR as u32),
            1
        );
        assert_eq!(state().world.block_light(0, MIN_Y + 15, 8), 0);
    }

    #[test]
    fn split_meshing_matches_client_mesh() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        // The mesh-only entry point works before client_new.
        let mut padded = vec![blocks::AIR; PADDED_LEN];
        padded[padded_index(0, 0, 0)] = blocks::STONE;
        assert_eq!(
            unsafe {
                mesh_padded(
                    padded.as_ptr(),
                    padded.len(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            6
        );
        client_new();
        let mut chunk = Chunk::empty(0, 0);
        for y in MIN_Y..MIN_Y + 32 {
            for z in 0..16 {
                for x in 0..16 {
                    if (x + z + y) % 3 != 0 {
                        chunk.set(x as usize, y, z as usize, blocks::STONE);
                    }
                }
            }
        }
        state().world.insert_chunk(chunk);
        assert!(state().world.lighting_enabled());
        assert!(state().world.chunks[&(0, 0)].lighting.is_some());
        assert_eq!(client_padded_light(0, 0, 0), PADDED_LEN);

        for (cx, sy, cz) in [(0, 0, 0), (0, 1, 0), (0, 2, 0), (1, 0, 0), (0, -1, 0)] {
            let quads = client_mesh(cx, sy, cz);
            let expected = unsafe {
                std::slice::from_raw_parts(
                    client_mesh_ptr(),
                    quads as usize * mesher::WORDS_PER_QUAD,
                )
            }
            .to_vec();
            let len = client_padded(cx, sy, cz);
            let actual = unsafe {
                mesh_padded(
                    client_padded_ptr(),
                    len,
                    client_padded_sky_ptr(),
                    client_padded_block_ptr(),
                )
            };
            assert_eq!(actual, quads);
            assert_eq!(
                unsafe {
                    std::slice::from_raw_parts(
                        client_mesh_ptr(),
                        actual as usize * mesher::WORDS_PER_QUAD,
                    )
                },
                expected
            );
        }
    }
}
