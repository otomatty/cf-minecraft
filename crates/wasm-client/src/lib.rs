//! C ABI for the client side: a mirror of the chunks the server has sent,
//! packet encoding/decoding, section meshing and block ray casts.
//!
//! Same conventions as `wasm-server`: no imports, byte results go to an
//! internal buffer (`client_out_ptr`), mesh vertices to a second one
//! (`client_mesh_ptr`).

use std::cell::UnsafeCell;
use std::collections::BTreeSet;

use mesher::{padded_index, PADDED_LEN};
use protocol::{C2S, PROTOCOL_VERSION, S2C};
use world::io::Reader;
use world::{blocks, Chunk, World, HEIGHT, MIN_Y, SECTIONS};

/// Stand-in for blocks of chunks that have not arrived yet: treated as solid
/// so no faces are built against the unknown, then re-meshed on arrival.
const UNKNOWN: u16 = blocks::STONE;

struct State {
    world: World,
    /// Sections whose mesh is stale: (chunk x, section index, chunk z).
    dirty: BTreeSet<(i32, i32, i32)>,
    unloaded: Vec<(i32, i32)>,
    seed: i64,
    spawn: [f64; 3],
    view_distance: u32,
    game_time: i64,
    day_time: i64,
    out: Vec<u8>,
    mesh: Vec<u32>,
    padded: Vec<u16>,
    player: physics::Player,
    flying: bool,
}

struct Global(UnsafeCell<Option<State>>);
// SAFETY: a WebAssembly instance without threads is only ever entered from one thread.
unsafe impl Sync for Global {}
static STATE: Global = Global(UnsafeCell::new(None));

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
        world: World::new(),
        dirty: BTreeSet::new(),
        unloaded: Vec::new(),
        seed: 0,
        spawn: [0.0; 3],
        view_distance: 0,
        game_time: 0,
        day_time: 0,
        out: Vec::new(),
        mesh: Vec::new(),
        padded: vec![blocks::AIR; PADDED_LEN],
        player: physics::Player::default(),
        flying: true,
    };
    // SAFETY: single-threaded.
    unsafe { *STATE.0.get() = Some(st) };
}

/// Discards the mirror and queues all old chunk meshes for removal.
#[no_mangle]
pub extern "C" fn client_reset_world() {
    let st = state();
    st.unloaded.extend(st.world.chunks.keys().copied());
    st.world.chunks.clear();
    st.dirty.clear();
}

#[no_mangle]
pub extern "C" fn client_out_ptr() -> *const u8 {
    state().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn client_mesh_ptr() -> *const u32 {
    state().mesh.as_ptr()
}

fn mark_chunk_dirty(st: &mut State, cx: i32, cz: i32) {
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
        S2C::ChunkData { cx, cz, data } => {
            let Ok(chunk) = Chunk::read(cx, cz, &mut Reader::new(&data)) else {
                return u32::MAX;
            };
            st.world.chunks.insert((cx, cz), chunk);
            mark_chunk_dirty(st, cx, cz);
            // Border faces of the neighbours can now be culled.
            for (dx, dz) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                mark_chunk_dirty(st, cx + dx, cz + dz);
            }
        }
        S2C::UnloadChunk { cx, cz } => {
            if st.world.chunks.remove(&(cx, cz)).is_some() {
                st.unloaded.push((cx, cz));
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
    bytes[0] as u32
}

fn set_block(st: &mut State, x: i32, y: i32, z: i32, block: u16) -> bool {
    if !blocks::is_valid(block) {
        return false;
    }
    match st.world.set_block(x, y, z, block) {
        Some(old) if old != block => {
            // Faces and ambient occlusion of every block touching this one,
            // including diagonally, may change: mark each section in reach.
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
    state().dirty.len() as u32
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

/// Meshes one section into the mesh buffer and returns the quad count.
#[no_mangle]
pub extern "C" fn client_mesh(cx: i32, sy: i32, cz: i32) -> u32 {
    let st = state();
    st.mesh.clear();
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
    mesher::mesh_section(&st.padded, &mut st.mesh)
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

/// Walks the voxel grid along a ray and stops at the first non-air block.
/// Output on hit: `[x][y][z][face]` as i32 LE, where face is the side that was
/// entered (`Direction` order). Returns 1 on hit.
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
    // Faces by axis and step direction: entering while moving +x means the west face, and so on.
    const FACE: [[i32; 2]; 3] = [[4, 5], [0, 1], [2, 3]];
    let mut face = -1i32;
    loop {
        if let Some(b) = st.world.get_block(cell[0], cell[1], cell[2]) {
            if b != blocks::AIR && face >= 0 {
                st.out.clear();
                for v in [cell[0], cell[1], cell[2], face] {
                    st.out.extend_from_slice(&v.to_le_bytes());
                }
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
        face = FACE[a][if step[a] > 0 { 0 } else { 1 }];
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

/// Reset prediction after spawn or a debug camera teleport. Coordinates are feet.
#[no_mangle]
pub extern "C" fn client_player_reset(x: f64, y: f64, z: f64) {
    let st = state();
    st.player = physics::Player::new([x, y, z]);
    st.flying = true;
}

struct Collisions<'a>(&'a World);
impl physics::CollisionWorld for Collisions<'_> {
    fn collision_box(&self, x: i32, y: i32, z: i32) -> Option<physics::Aabb> {
        // Unknown chunks are solid: never predict a fall into unloaded terrain.
        self.0
            .get_block(x, y, z)
            .is_none_or(blocks::is_opaque)
            .then(|| physics::Aabb::block(x, y, z))
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
