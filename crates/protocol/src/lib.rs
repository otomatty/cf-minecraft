//! Wire protocol.
//!
//! Our own binary format, carried one packet per WebSocket message (or per
//! `postMessage` in single player). Primitive encodings follow the Java
//! protocol (big-endian, VarInt), and the packet set mirrors its semantics,
//! but it is not wire compatible with the game.

use world::io::{DecodeError, Reader, Writer};
use world::BlockState;

pub const PROTOCOL_VERSION: u32 = 30;
/// Item ID, count, and accumulated damage.
pub type ItemStack = (u16, u8, u16);

pub const MAX_HEALTH: u8 = 20;
pub const MAX_FOOD: u8 = 20;
pub const MAX_AIR: u16 = 300;

const MAX_CHAT_TEXT_BYTES: usize = 1024;
const MAX_CHAT_SENDER_BYTES: usize = 64;
const MAX_PLAYER_NAME_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ChatKind {
    Player = 0,
    Join = 1,
    Leave = 2,
    /// Server notice. `sender` is empty and `text` is shown as-is.
    System = 3,
    /// `/me`. `sender` is the speaker.
    Emote = 4,
    /// Whisper delivered to the recipient. `sender` is the speaker.
    WhisperFrom = 5,
    /// Whisper delivered to the speaker. `sender` is the recipient.
    WhisperTo = 6,
}

impl ChatKind {
    fn from_wire_id(value: u8) -> Result<Self, DecodeError> {
        match value {
            0 => Ok(Self::Player),
            1 => Ok(Self::Join),
            2 => Ok(Self::Leave),
            3 => Ok(Self::System),
            4 => Ok(Self::Emote),
            5 => Ok(Self::WhisperFrom),
            6 => Ok(Self::WhisperTo),
            _ => Err(DecodeError),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MobKind {
    Cow = 0,
    Pig = 1,
    Chicken = 2,
    Sheep = 3,
    Zombie = 4,
    Skeleton = 5,
    Creeper = 6,
}

impl MobKind {
    pub const fn wire_id(self) -> u8 {
        self as u8
    }

    fn from_wire_id(value: u8) -> Result<Self, DecodeError> {
        match value {
            0 => Ok(Self::Cow),
            1 => Ok(Self::Pig),
            2 => Ok(Self::Chicken),
            3 => Ok(Self::Sheep),
            4 => Ok(Self::Zombie),
            5 => Ok(Self::Skeleton),
            6 => Ok(Self::Creeper),
            _ => Err(DecodeError),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum WoolColor {
    #[default]
    White = 0,
    Gray = 1,
    Brown = 2,
    Black = 3,
}

impl WoolColor {
    pub fn from_wire_id(id: u8) -> Result<Self, DecodeError> {
        match id {
            0 => Ok(Self::White),
            1 => Ok(Self::Gray),
            2 => Ok(Self::Brown),
            3 => Ok(Self::Black),
            _ => Err(DecodeError),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DeathCause {
    None = 0,
    Fall = 1,
    Suffocation = 2,
    Drowning = 3,
    Void = 4,
    Lava = 5,
    Zombie = 6,
    Arrow = 7,
    Explosion = 8,
}

/// Fields shared by the status packet and the player save.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlayerVitals {
    pub health: u8,
    pub air: u16,
    pub dead: bool,
    pub cause: DeathCause,
    pub food: u8,
}

impl Default for PlayerVitals {
    fn default() -> Self {
        Self {
            health: MAX_HEALTH,
            air: MAX_AIR,
            dead: false,
            cause: DeathCause::None,
            food: MAX_FOOD,
        }
    }
}

impl PlayerVitals {
    pub fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Self::read_fields(r, true)
    }

    pub fn read_v4(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Self::read_fields(r, false)
    }

    fn read_fields(r: &mut Reader<'_>, has_food: bool) -> Result<Self, DecodeError> {
        let (health, air, dead) = (r.u8()?, r.u16()?, r.u8()?);
        let cause = match r.u8()? {
            0 => DeathCause::None,
            1 => DeathCause::Fall,
            2 => DeathCause::Suffocation,
            3 => DeathCause::Drowning,
            4 => DeathCause::Void,
            5 => DeathCause::Lava,
            6 => DeathCause::Zombie,
            7 => DeathCause::Arrow,
            8 => DeathCause::Explosion,
            _ => return Err(DecodeError),
        };
        let food = if has_food { r.u8()? } else { MAX_FOOD };
        if health > MAX_HEALTH
            || food > MAX_FOOD
            || air > MAX_AIR
            || dead > 1
            || (health == 0) != (dead == 1)
            || (cause != DeathCause::None) != (dead == 1)
        {
            return Err(DecodeError);
        }
        Ok(Self {
            health,
            air,
            dead: dead == 1,
            cause,
            food,
        })
    }

    pub fn write(self, w: &mut Writer) {
        write_vitals(
            w,
            self.health,
            self.air,
            self.dead,
            self.cause as u8,
            self.food,
        );
    }

    pub fn packet(self) -> S2C {
        S2C::PlayerStatus {
            health: self.health,
            air: self.air,
            dead: self.dead,
            cause: self.cause as u8,
            food: self.food,
        }
    }
}

fn write_player_pose(w: &mut Writer, pos: [f64; 3], yaw: f32, pitch: f32) {
    for value in pos {
        w.f64(value);
    }
    w.f32(yaw);
    w.f32(pitch);
}

fn finite_angles(r: &mut Reader<'_>) -> Result<(f32, f32), DecodeError> {
    let yaw = r.f32()?;
    let pitch = r.f32()?;
    if yaw.is_finite() && pitch.is_finite() {
        Ok((yaw, pitch))
    } else {
        Err(DecodeError)
    }
}

fn write_vitals(w: &mut Writer, health: u8, air: u16, dead: bool, cause: u8, food: u8) {
    w.u8(health);
    w.u16(air);
    w.u8(u8::from(dead));
    w.u8(cause);
    w.u8(food);
}

/// Senders clamp furnace display timers to this value, and decoding rejects larger values.
pub const MAX_FURNACE_DISPLAY_TICKS: u16 = 1600;

/// Client to server.
#[derive(Clone, Debug, PartialEq)]
pub enum C2S {
    Chat {
        text: String,
    },
    Respawn,
    UseItem,
    StopUsingItem,
    CancelUsingItem,
    ClickSlot {
        slot: u8,
        button: u8,
        shift: bool,
    },
    CloseInventory,
    UseBlock {
        x: i32,
        y: i32,
        z: i32,
    },
    UseBucket {
        x: i32,
        y: i32,
        z: i32,
    },
    DigStart {
        x: i32,
        y: i32,
        z: i32,
    },
    DigAbort,
    Attack {
        id: u32,
    },
    UseEntity {
        id: u32,
    },
    DropItem {
        dir: [f32; 3],
    },
    SelectSlot {
        slot: u8,
    },
    CreativeSetSlot {
        slot: u8,
        item: u16,
        count: u8,
    },
    Hello {
        protocol: u32,
        view_distance: u8,
    },
    PlayerPos {
        x: f64,
        y: f64,
        z: f64,
        yaw: f32,
        pitch: f32,
    },
    Teleport {
        x: f64,
        y: f64,
        z: f64,
    },
    SetBlock {
        x: i32,
        y: i32,
        z: i32,
        state: BlockState,
    },
}

/// Server to client.
#[derive(Clone, Debug, PartialEq)]
pub enum S2C {
    Chat {
        kind: ChatKind,
        sender: String,
        text: String,
    },
    PlayerStatus {
        health: u8,
        air: u16,
        dead: bool,
        cause: u8,
        food: u8,
    },
    DigProgress {
        player: u32,
        x: i32,
        y: i32,
        z: i32,
        stage: u8,
    },
    ToolBreak,
    Shear,
    EntitySpawn {
        id: u32,
        kind: u8,
        item: u16,
        count: u8,
        damage: u16,
        x: f64,
        y: f64,
        z: f64,
    },
    EntityMove {
        id: u32,
        x: f64,
        y: f64,
        z: f64,
    },
    EntityCount {
        id: u32,
        count: u8,
    },
    MobSpawn {
        id: u32,
        kind: MobKind,
        x: f64,
        y: f64,
        z: f64,
        yaw: f32,
    },
    MobMove {
        id: u32,
        x: f64,
        y: f64,
        z: f64,
        yaw: f32,
    },
    ArrowSpawn {
        id: u32,
        pos: [f64; 3],
        velocity: [f64; 3],
        fresh: bool,
    },
    ArrowMove {
        id: u32,
        pos: [f64; 3],
        velocity: [f64; 3],
    },
    EggSpawn {
        id: u32,
        pos: [f64; 3],
    },
    EggSound {
        pos: [f64; 3],
        broken: bool,
    },
    MobHurt {
        id: u32,
    },
    MobFuse {
        id: u32,
        ticks: u8,
    },
    /// Impulse added to the receiving player's velocity. The server does not move them.
    /// For walking prediction, halve each horizontal velocity before adding its
    /// impulse component. On dry ground, halve the vertical velocity, add the
    /// vertical impulse and cap the result at 0.4 blocks/tick. In air or fluid,
    /// keep the vertical velocity. Flying prediction applies direct addition.
    PlayerKnockback {
        velocity: [f64; 3],
    },
    /// Visual flame on a mob. Values other than 0 or 1 are rejected.
    MobBurning {
        id: u32,
        burning: bool,
    },
    /// Sent after a sheep spawns and whenever its fleece changes.
    SheepAppearance {
        id: u32,
        color: WoolColor,
        sheared: bool,
    },
    /// Blast center. Sent once on the tick the explosion happens.
    Explosion {
        center: [f64; 3],
    },
    EntityRemove {
        id: u32,
    },
    Inventory {
        furnace: [Option<ItemStack>; 3],
        burn: u16,
        total: u16,
        progress: u16,
        screen: u8,
        table: [Option<ItemStack>; 9],
        selected: u8,
        slots: Vec<Option<ItemStack>>,
        crafting: [Option<ItemStack>; 4],
        result: Option<ItemStack>,
        cursor: Option<ItemStack>,
    },
    Welcome {
        seed: i64,
        game_time: i64,
        spawn: [f64; 3],
        view_distance: u8,
        game_mode: u8,
    },
    ChunkData {
        cx: i32,
        cz: i32,
        data: Vec<u8>,
    },
    UnloadChunk {
        cx: i32,
        cz: i32,
    },
    BlockUpdate {
        x: i32,
        y: i32,
        z: i32,
        state: BlockState,
    },
    PlayerCorrect {
        x: f64,
        y: f64,
        z: f64,
    },
    TimeUpdate {
        game_time: i64,
        day_time: i64,
    },
    /// Another joined player. `id` is the connection id, not an entity id.
    PlayerSpawn {
        id: u32,
        name: String,
        pos: [f64; 3],
        yaw: f32,
        pitch: f32,
    },
    PlayerMove {
        id: u32,
        pos: [f64; 3],
        yaw: f32,
        pitch: f32,
    },
    PlayerRemove {
        id: u32,
    },
}

pub mod id {
    pub const C2S_RESPAWN: u8 = 0x0c;
    pub const C2S_USE_ITEM: u8 = 0x0d;
    pub const C2S_STOP_USING_ITEM: u8 = 0x0e;
    pub const S2C_PLAYER_STATUS: u8 = 0x0c;
    pub const C2S_USE_BLOCK: u8 = 0x0b;
    pub const C2S_USE_BUCKET: u8 = 0x0f;
    pub const C2S_ATTACK: u8 = 0x10;
    pub const C2S_CANCEL_USING_ITEM: u8 = 0x11;
    pub const C2S_CHAT: u8 = 0x12;
    pub const C2S_USE_ENTITY: u8 = 0x13;
    pub const C2S_CLICK_SLOT: u8 = 0x09;
    pub const C2S_CLOSE_INVENTORY: u8 = 0x0a;
    pub const C2S_DIG_START: u8 = 0x07;
    pub const C2S_DIG_ABORT: u8 = 0x08;
    pub const S2C_DIG_PROGRESS: u8 = 0x0b;
    pub const C2S_DROP_ITEM: u8 = 0x06;
    pub const S2C_ENTITY_SPAWN: u8 = 0x07;
    pub const S2C_ENTITY_MOVE: u8 = 0x08;
    pub const S2C_ENTITY_COUNT: u8 = 0x09;
    pub const S2C_MOB_SPAWN: u8 = 0x0d;
    pub const S2C_MOB_MOVE: u8 = 0x0e;
    pub const S2C_MOB_HURT: u8 = 0x0f;
    pub const S2C_ARROW_SPAWN: u8 = 0x10;
    pub const S2C_ARROW_MOVE: u8 = 0x11;
    pub const S2C_MOB_FUSE: u8 = 0x12;
    pub const S2C_CHAT: u8 = 0x13;
    pub const S2C_PLAYER_KNOCKBACK: u8 = 0x14;
    pub const S2C_MOB_BURNING: u8 = 0x15;
    pub const S2C_EXPLOSION: u8 = 0x16;
    pub const S2C_PLAYER_SPAWN: u8 = 0x17;
    pub const S2C_PLAYER_MOVE: u8 = 0x18;
    pub const S2C_TOOL_BREAK: u8 = 0x1a;
    pub const S2C_SHEEP_APPEARANCE: u8 = 0x1b;
    pub const S2C_SHEAR: u8 = 0x1c;
    pub const S2C_EGG_SPAWN: u8 = 0x1d;
    pub const S2C_EGG_SOUND: u8 = 0x1e;
    pub const S2C_PLAYER_REMOVE: u8 = 0x19;
    pub const S2C_ENTITY_REMOVE: u8 = 0x0a;
    pub const C2S_SELECT_SLOT: u8 = 0x04;
    pub const C2S_CREATIVE_SET_SLOT: u8 = 0x05;
    pub const S2C_INVENTORY: u8 = 0x06;
    pub const C2S_HELLO: u8 = 0x00;
    pub const C2S_PLAYER_POS: u8 = 0x01;
    pub const C2S_TELEPORT: u8 = 0x03;
    pub const C2S_SET_BLOCK: u8 = 0x02;

    pub const S2C_WELCOME: u8 = 0x00;
    pub const S2C_CHUNK_DATA: u8 = 0x01;
    pub const S2C_UNLOAD_CHUNK: u8 = 0x02;
    pub const S2C_BLOCK_UPDATE: u8 = 0x03;
    pub const S2C_PLAYER_CORRECT: u8 = 0x05;
    pub const S2C_TIME_UPDATE: u8 = 0x04;
}

impl C2S {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        match *self {
            Self::Chat { ref text } => {
                w.u8(id::C2S_CHAT);
                w.string(text);
            }
            C2S::Respawn => w.u8(id::C2S_RESPAWN),
            C2S::UseItem => w.u8(id::C2S_USE_ITEM),
            C2S::StopUsingItem => w.u8(id::C2S_STOP_USING_ITEM),
            C2S::CancelUsingItem => w.u8(id::C2S_CANCEL_USING_ITEM),
            C2S::ClickSlot {
                slot,
                button,
                shift,
            } => {
                w.u8(id::C2S_CLICK_SLOT);
                w.u8(slot);
                w.u8(button);
                w.u8(u8::from(shift));
            }
            C2S::UseBlock { x, y, z } => {
                w.u8(id::C2S_USE_BLOCK);
                w.i32(x);
                w.i32(y);
                w.i32(z);
            }
            C2S::UseBucket { x, y, z } => {
                w.u8(id::C2S_USE_BUCKET);
                w.i32(x);
                w.i32(y);
                w.i32(z);
            }
            C2S::CloseInventory => w.u8(id::C2S_CLOSE_INVENTORY),
            C2S::DigStart { x, y, z } => {
                w.u8(id::C2S_DIG_START);
                w.i32(x);
                w.i32(y);
                w.i32(z);
            }
            C2S::DigAbort => w.u8(id::C2S_DIG_ABORT),
            C2S::Attack { id: entity } => {
                w.u8(id::C2S_ATTACK);
                w.i32(entity as i32);
            }
            C2S::UseEntity { id: entity } => {
                w.u8(id::C2S_USE_ENTITY);
                w.i32(entity as i32);
            }
            C2S::DropItem { dir } => {
                w.u8(id::C2S_DROP_ITEM);
                for v in dir {
                    w.f32(v);
                }
            }
            C2S::SelectSlot { slot } => {
                w.u8(id::C2S_SELECT_SLOT);
                w.u8(slot);
            }
            C2S::CreativeSetSlot { slot, item, count } => {
                w.u8(id::C2S_CREATIVE_SET_SLOT);
                w.u8(slot);
                w.u16(item);
                w.u8(count);
            }

            C2S::Hello {
                protocol,
                view_distance,
            } => {
                w.u8(id::C2S_HELLO);
                w.varint(protocol);
                w.u8(view_distance);
            }
            C2S::PlayerPos {
                x,
                y,
                z,
                yaw,
                pitch,
            } => {
                w.u8(id::C2S_PLAYER_POS);
                w.f64(x);
                w.f64(y);
                w.f64(z);
                w.f32(yaw);
                w.f32(pitch);
            }
            C2S::Teleport { x, y, z } => {
                w.u8(id::C2S_TELEPORT);
                w.f64(x);
                w.f64(y);
                w.f64(z);
            }
            C2S::SetBlock { x, y, z, state } => {
                w.u8(id::C2S_SET_BLOCK);
                w.i32(x);
                w.i32(y);
                w.i32(z);
                w.varint(state as u32);
            }
        }
        w.finish()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(bytes);
        let packet = match r.u8()? {
            id::C2S_CHAT => Self::Chat {
                text: r.string(MAX_CHAT_TEXT_BYTES)?.to_owned(),
            },
            id::C2S_CLICK_SLOT => {
                let (slot, button, shift) = (r.u8()?, r.u8()?, r.u8()?);
                if slot > 53 || button > 1 || shift > 1 {
                    return Err(DecodeError);
                }
                C2S::ClickSlot {
                    slot,
                    button,
                    shift: shift != 0,
                }
            }
            id::C2S_USE_BLOCK => C2S::UseBlock {
                x: r.i32()?,
                y: r.i32()?,
                z: r.i32()?,
            },
            id::C2S_USE_BUCKET => C2S::UseBucket {
                x: r.i32()?,
                y: r.i32()?,
                z: r.i32()?,
            },
            id::C2S_RESPAWN => C2S::Respawn,
            id::C2S_USE_ITEM => C2S::UseItem,
            id::C2S_STOP_USING_ITEM => C2S::StopUsingItem,
            id::C2S_CANCEL_USING_ITEM => C2S::CancelUsingItem,
            id::C2S_CLOSE_INVENTORY => C2S::CloseInventory,
            id::C2S_DIG_START => C2S::DigStart {
                x: r.i32()?,
                y: r.i32()?,
                z: r.i32()?,
            },
            id::C2S_DIG_ABORT => C2S::DigAbort,
            id::C2S_ATTACK => C2S::Attack {
                id: r.i32()? as u32,
            },
            id::C2S_USE_ENTITY => C2S::UseEntity {
                id: r.i32()? as u32,
            },
            id::C2S_DROP_ITEM => {
                let dir = [r.f32()?, r.f32()?, r.f32()?];
                if !dir.iter().all(|v| v.is_finite()) {
                    return Err(DecodeError);
                }
                C2S::DropItem { dir }
            }
            id::C2S_SELECT_SLOT => {
                let slot = r.u8()?;
                if slot >= 9 {
                    return Err(DecodeError);
                }
                C2S::SelectSlot { slot }
            }
            id::C2S_CREATIVE_SET_SLOT => {
                let slot = r.u8()?;
                let item = r.u16()?;
                let count = r.u8()?;
                if slot >= 36
                    || (item != 0
                        && !world::items::info(item)
                            .is_some_and(|i| (1..=i.max_stack).contains(&count)))
                {
                    return Err(DecodeError);
                }
                C2S::CreativeSetSlot { slot, item, count }
            }
            id::C2S_HELLO => C2S::Hello {
                protocol: r.varint()?,
                view_distance: r.u8()?,
            },
            id::C2S_PLAYER_POS => C2S::PlayerPos {
                x: r.f64()?,
                y: r.f64()?,
                z: r.f64()?,
                yaw: r.f32()?,
                pitch: r.f32()?,
            },
            id::C2S_TELEPORT => C2S::Teleport {
                x: r.f64()?,
                y: r.f64()?,
                z: r.f64()?,
            },
            id::C2S_SET_BLOCK => {
                let (x, y, z) = (r.i32()?, r.i32()?, r.i32()?);
                let state = r.varint()?;
                if state > u16::MAX as u32 {
                    return Err(DecodeError);
                }
                C2S::SetBlock {
                    x,
                    y,
                    z,
                    state: state as BlockState,
                }
            }
            _ => return Err(DecodeError),
        };
        if r.remaining() != 0 {
            return Err(DecodeError);
        }
        Ok(packet)
    }
}

impl S2C {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        match self {
            Self::Chat { kind, sender, text } => {
                w.u8(id::S2C_CHAT);
                w.u8(*kind as u8);
                w.string(sender);
                w.string(text);
            }
            S2C::DigProgress {
                player,
                x,
                y,
                z,
                stage,
            } => {
                w.u8(id::S2C_DIG_PROGRESS);
                w.i32(*player as i32);
                w.i32(*x);
                w.i32(*y);
                w.i32(*z);
                w.u8(*stage);
            }
            S2C::ToolBreak => w.u8(id::S2C_TOOL_BREAK),
            S2C::Shear => w.u8(id::S2C_SHEAR),
            S2C::EggSpawn { id: entity, pos } => {
                w.u8(id::S2C_EGG_SPAWN);
                w.i32(*entity as i32);
                for &axis in pos {
                    w.f64(axis);
                }
            }
            S2C::EggSound { pos, broken } => {
                w.u8(id::S2C_EGG_SOUND);
                for &axis in pos {
                    w.f64(axis);
                }
                w.u8(u8::from(*broken));
            }
            S2C::EntitySpawn {
                id: entity,
                kind,
                item,
                count,
                damage,
                x,
                y,
                z,
            } => {
                w.u8(id::S2C_ENTITY_SPAWN);
                w.i32(*entity as i32);
                w.u8(*kind);
                write_stack(&mut w, Some((*item, *count, *damage)));
                w.f64(*x);
                w.f64(*y);
                w.f64(*z);
            }
            S2C::EntityMove {
                id: entity,
                x,
                y,
                z,
            } => {
                w.u8(id::S2C_ENTITY_MOVE);
                w.i32(*entity as i32);
                w.f64(*x);
                w.f64(*y);
                w.f64(*z);
            }
            S2C::EntityCount { id: entity, count } => {
                w.u8(id::S2C_ENTITY_COUNT);
                w.i32(*entity as i32);
                w.u8(*count);
            }
            S2C::MobSpawn {
                id: entity,
                kind,
                x,
                y,
                z,
                yaw,
            } => {
                w.u8(id::S2C_MOB_SPAWN);
                w.i32(*entity as i32);
                w.u8(kind.wire_id());
                w.f64(*x);
                w.f64(*y);
                w.f64(*z);
                w.f32(*yaw);
            }
            S2C::MobMove {
                id: entity,
                x,
                y,
                z,
                yaw,
            } => {
                w.u8(id::S2C_MOB_MOVE);
                w.i32(*entity as i32);
                w.f64(*x);
                w.f64(*y);
                w.f64(*z);
                w.f32(*yaw);
            }
            S2C::ArrowSpawn {
                id: entity,
                pos,
                velocity,
                ..
            }
            | S2C::ArrowMove {
                id: entity,
                pos,
                velocity,
            } => {
                w.u8(if matches!(self, S2C::ArrowSpawn { .. }) {
                    id::S2C_ARROW_SPAWN
                } else {
                    id::S2C_ARROW_MOVE
                });
                w.i32(*entity as i32);
                for value in pos.iter().chain(velocity) {
                    w.f64(*value);
                }
                if let S2C::ArrowSpawn { fresh, .. } = self {
                    w.u8(u8::from(*fresh));
                }
            }
            S2C::MobHurt { id: entity } => {
                w.u8(id::S2C_MOB_HURT);
                w.i32(*entity as i32);
            }
            S2C::MobFuse { id: entity, ticks } => {
                w.u8(id::S2C_MOB_FUSE);
                w.i32(*entity as i32);
                w.u8(*ticks);
            }
            S2C::PlayerKnockback { velocity } => {
                w.u8(id::S2C_PLAYER_KNOCKBACK);
                for value in velocity {
                    w.f64(*value);
                }
            }
            S2C::MobBurning {
                id: entity,
                burning,
            } => {
                w.u8(id::S2C_MOB_BURNING);
                w.i32(*entity as i32);
                w.u8(u8::from(*burning));
            }
            S2C::SheepAppearance {
                id: entity,
                color,
                sheared,
            } => {
                w.u8(id::S2C_SHEEP_APPEARANCE);
                w.i32(*entity as i32);
                w.u8(*color as u8);
                w.u8(u8::from(*sheared));
            }
            S2C::Explosion { center } => {
                w.u8(id::S2C_EXPLOSION);
                for value in center {
                    w.f64(*value);
                }
            }
            S2C::EntityRemove { id: entity } => {
                w.u8(id::S2C_ENTITY_REMOVE);
                w.i32(*entity as i32);
            }

            S2C::Inventory {
                furnace,
                burn,
                total,
                progress,
                screen,
                table,
                selected,
                slots,
                crafting,
                result,
                cursor,
            } => {
                w.u8(id::S2C_INVENTORY);
                w.u8(*selected);
                w.u8(slots.len() as u8);
                for &slot in slots.iter().chain(crafting).chain([result, cursor]) {
                    write_stack(&mut w, slot);
                }
                w.u8(*screen);
                for &slot in table.iter().chain(furnace) {
                    write_stack(&mut w, slot);
                }
                w.u16(*burn);
                w.u16(*total);
                w.u16(*progress);
            }

            S2C::Welcome {
                seed,
                game_time,
                spawn,
                view_distance,
                game_mode,
            } => {
                w.u8(id::S2C_WELCOME);
                w.i64(*seed);
                w.i64(*game_time);
                for v in spawn {
                    w.f64(*v);
                }
                w.u8(*view_distance);
                w.u8(*game_mode);
            }
            S2C::ChunkData { cx, cz, data } => {
                w.u8(id::S2C_CHUNK_DATA);
                w.i32(*cx);
                w.i32(*cz);
                w.raw(data);
            }
            S2C::UnloadChunk { cx, cz } => {
                w.u8(id::S2C_UNLOAD_CHUNK);
                w.i32(*cx);
                w.i32(*cz);
            }
            S2C::BlockUpdate { x, y, z, state } => {
                w.u8(id::S2C_BLOCK_UPDATE);
                w.i32(*x);
                w.i32(*y);
                w.i32(*z);
                w.varint(*state as u32);
            }
            S2C::PlayerStatus {
                health,
                air,
                dead,
                cause,
                food,
            } => {
                w.u8(id::S2C_PLAYER_STATUS);
                write_vitals(&mut w, *health, *air, *dead, *cause, *food);
            }
            S2C::PlayerCorrect { x, y, z } => {
                w.u8(id::S2C_PLAYER_CORRECT);
                w.f64(*x);
                w.f64(*y);
                w.f64(*z);
            }
            S2C::TimeUpdate {
                game_time,
                day_time,
            } => {
                w.u8(id::S2C_TIME_UPDATE);
                w.i64(*game_time);
                w.i64(*day_time);
            }
            S2C::PlayerSpawn {
                id: player,
                name,
                pos,
                yaw,
                pitch,
            } => {
                w.u8(id::S2C_PLAYER_SPAWN);
                w.i32(*player as i32);
                w.string(name);
                write_player_pose(&mut w, *pos, *yaw, *pitch);
            }
            S2C::PlayerMove {
                id: player,
                pos,
                yaw,
                pitch,
            } => {
                w.u8(id::S2C_PLAYER_MOVE);
                w.i32(*player as i32);
                write_player_pose(&mut w, *pos, *yaw, *pitch);
            }
            S2C::PlayerRemove { id: player } => {
                w.u8(id::S2C_PLAYER_REMOVE);
                w.i32(*player as i32);
            }
        }
        w.finish()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(bytes);
        let packet = match r.u8()? {
            id::S2C_TOOL_BREAK => S2C::ToolBreak,
            id::S2C_SHEAR => S2C::Shear,
            id::S2C_EGG_SPAWN => S2C::EggSpawn {
                id: entity_id(&mut r)?,
                pos: entity_pos(&mut r)?,
            },
            id::S2C_EGG_SOUND => S2C::EggSound {
                pos: entity_pos(&mut r)?,
                broken: match r.u8()? {
                    0 => false,
                    1 => true,
                    _ => return Err(DecodeError),
                },
            },
            id::S2C_ENTITY_SPAWN => {
                let id = entity_id(&mut r)?;
                let kind = r.u8()?;
                let (item, count, damage) = read_stack(&mut r)?.ok_or(DecodeError)?;
                if kind != 0 {
                    return Err(DecodeError);
                }
                let [x, y, z] = entity_pos(&mut r)?;
                S2C::EntitySpawn {
                    id,
                    kind,
                    item,
                    count,
                    damage,
                    x,
                    y,
                    z,
                }
            }
            id::S2C_ENTITY_MOVE => {
                let id = entity_id(&mut r)?;
                let [x, y, z] = entity_pos(&mut r)?;
                S2C::EntityMove { id, x, y, z }
            }
            tag @ (id::S2C_MOB_SPAWN | id::S2C_MOB_MOVE) => {
                let id = entity_id(&mut r)?;
                let kind = if tag == id::S2C_MOB_SPAWN {
                    Some(MobKind::from_wire_id(r.u8()?)?)
                } else {
                    None
                };
                let [x, y, z] = entity_pos(&mut r)?;
                let yaw = r.f32()?;
                if !yaw.is_finite() {
                    return Err(DecodeError);
                }
                match kind {
                    Some(kind) => S2C::MobSpawn {
                        id,
                        kind,
                        x,
                        y,
                        z,
                        yaw,
                    },
                    None => S2C::MobMove { id, x, y, z, yaw },
                }
            }
            tag @ (id::S2C_ARROW_SPAWN | id::S2C_ARROW_MOVE) => {
                let id = entity_id(&mut r)?;
                let pos = entity_pos(&mut r)?;
                let velocity = entity_pos(&mut r)?;
                if tag == id::S2C_ARROW_SPAWN {
                    let fresh = match r.u8()? {
                        0 => false,
                        1 => true,
                        _ => return Err(DecodeError),
                    };
                    S2C::ArrowSpawn {
                        id,
                        pos,
                        velocity,
                        fresh,
                    }
                } else {
                    S2C::ArrowMove { id, pos, velocity }
                }
            }
            id::S2C_ENTITY_COUNT => {
                let id = entity_id(&mut r)?;
                let count = r.u8()?;
                if !(1..=64).contains(&count) {
                    return Err(DecodeError);
                }
                S2C::EntityCount { id, count }
            }
            id::S2C_DIG_PROGRESS => {
                let player = entity_id(&mut r)?;
                let (x, y, z) = (r.i32()?, r.i32()?, r.i32()?);
                let stage = r.u8()?;
                if stage > 9 && stage != 255 {
                    return Err(DecodeError);
                }
                S2C::DigProgress {
                    player,
                    x,
                    y,
                    z,
                    stage,
                }
            }
            id::S2C_MOB_HURT => S2C::MobHurt {
                id: entity_id(&mut r)?,
            },
            id::S2C_MOB_FUSE => {
                let id = entity_id(&mut r)?;
                let ticks = r.u8()?;
                if ticks > 30 {
                    return Err(DecodeError);
                }
                S2C::MobFuse { id, ticks }
            }
            id::S2C_PLAYER_KNOCKBACK => S2C::PlayerKnockback {
                velocity: entity_pos(&mut r)?,
            },
            id::S2C_MOB_BURNING => {
                let id = entity_id(&mut r)?;
                let burning = match r.u8()? {
                    0 => false,
                    1 => true,
                    _ => return Err(DecodeError),
                };
                S2C::MobBurning { id, burning }
            }
            id::S2C_SHEEP_APPEARANCE => {
                let id = entity_id(&mut r)?;
                let color = WoolColor::from_wire_id(r.u8()?)?;
                let sheared = match r.u8()? {
                    0 => false,
                    1 => true,
                    _ => return Err(DecodeError),
                };
                S2C::SheepAppearance { id, color, sheared }
            }
            id::S2C_EXPLOSION => S2C::Explosion {
                center: entity_pos(&mut r)?,
            },
            id::S2C_ENTITY_REMOVE => S2C::EntityRemove {
                id: entity_id(&mut r)?,
            },
            id::S2C_INVENTORY => {
                let selected = r.u8()?;
                let n = r.u8()?;
                if selected >= 9 || n != 36 {
                    return Err(DecodeError);
                }
                let slots = (0..36)
                    .map(|_| read_stack(&mut r))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut extra = [None; 6];
                for slot in &mut extra {
                    *slot = read_stack(&mut r)?;
                }
                let screen = r.u8()?;
                if screen > 2 {
                    return Err(DecodeError);
                }
                let mut table = [None; 9];
                let mut furnace = [None; 3];
                for slot in table.iter_mut().chain(&mut furnace) {
                    *slot = read_stack(&mut r)?;
                }
                let burn = r.u16()?;
                let total = r.u16()?;
                let progress = r.u16()?;
                if burn > total
                    || total > MAX_FURNACE_DISPLAY_TICKS
                    || progress >= world::smelting::SMELT_TICKS
                    || (screen != 2
                        && (furnace != [None; 3] || burn != 0 || total != 0 || progress != 0))
                {
                    return Err(DecodeError);
                }
                S2C::Inventory {
                    furnace,
                    burn,
                    total,
                    progress,
                    screen,
                    table,
                    selected,
                    slots,
                    crafting: extra[..4].try_into().unwrap(),
                    result: extra[4],
                    cursor: extra[5],
                }
            }
            id::S2C_WELCOME => S2C::Welcome {
                seed: r.i64()?,
                game_time: r.i64()?,
                spawn: [r.f64()?, r.f64()?, r.f64()?],
                view_distance: r.u8()?,
                game_mode: {
                    let mode = r.u8()?;
                    if mode > 1 {
                        return Err(DecodeError);
                    }
                    mode
                },
            },
            id::S2C_CHUNK_DATA => {
                let (cx, cz) = (r.i32()?, r.i32()?);
                S2C::ChunkData {
                    cx,
                    cz,
                    data: r.rest().to_vec(),
                }
            }
            id::S2C_UNLOAD_CHUNK => S2C::UnloadChunk {
                cx: r.i32()?,
                cz: r.i32()?,
            },
            id::S2C_BLOCK_UPDATE => {
                let (x, y, z) = (r.i32()?, r.i32()?, r.i32()?);
                let state = r.varint()?;
                if state > u16::MAX as u32 {
                    return Err(DecodeError);
                }
                S2C::BlockUpdate {
                    x,
                    y,
                    z,
                    state: state as BlockState,
                }
            }
            id::S2C_PLAYER_STATUS => PlayerVitals::read(&mut r)?.packet(),
            id::S2C_PLAYER_CORRECT => S2C::PlayerCorrect {
                x: r.f64()?,
                y: r.f64()?,
                z: r.f64()?,
            },
            id::S2C_TIME_UPDATE => S2C::TimeUpdate {
                game_time: r.i64()?,
                day_time: r.i64()?,
            },
            id::S2C_CHAT => Self::Chat {
                kind: ChatKind::from_wire_id(r.u8()?)?,
                sender: r.string(MAX_CHAT_SENDER_BYTES)?.to_owned(),
                text: r.string(MAX_CHAT_TEXT_BYTES)?.to_owned(),
            },
            tag @ (id::S2C_PLAYER_SPAWN | id::S2C_PLAYER_MOVE) => {
                let id = entity_id(&mut r)?;
                let name = if tag == id::S2C_PLAYER_SPAWN {
                    Some(r.string(MAX_PLAYER_NAME_BYTES)?.to_owned())
                } else {
                    None
                };
                let pos = entity_pos(&mut r)?;
                let (yaw, pitch) = finite_angles(&mut r)?;
                match name {
                    Some(name) => S2C::PlayerSpawn {
                        id,
                        name,
                        pos,
                        yaw,
                        pitch,
                    },
                    None => S2C::PlayerMove {
                        id,
                        pos,
                        yaw,
                        pitch,
                    },
                }
            }
            id::S2C_PLAYER_REMOVE => S2C::PlayerRemove {
                id: entity_id(&mut r)?,
            },
            _ => return Err(DecodeError),
        };
        if r.remaining() != 0 {
            return Err(DecodeError);
        }
        Ok(packet)
    }
}

fn write_stack(w: &mut Writer, stack: Option<ItemStack>) {
    let (item, count, damage) = stack.unwrap_or_default();
    w.u16(item);
    w.u8(count);
    w.u16(damage);
}

fn read_stack(r: &mut Reader<'_>) -> Result<Option<ItemStack>, DecodeError> {
    let item = r.u16()?;
    let count = r.u8()?;
    let damage = r.u16()?;
    if (item, count, damage) == (0, 0, 0) {
        return Ok(None);
    }
    if !world::items::info(item).is_some_and(|info| {
        (1..=info.max_stack).contains(&count)
            && info.durability.map_or(damage == 0, |max| damage < max)
    }) {
        return Err(DecodeError);
    }
    Ok(Some((item, count, damage)))
}

fn entity_id(r: &mut Reader<'_>) -> Result<u32, DecodeError> {
    let id = r.i32()? as u32;
    if id == 0 {
        Err(DecodeError)
    } else {
        Ok(id)
    }
}
fn entity_pos(r: &mut Reader<'_>) -> Result<[f64; 3], DecodeError> {
    let p = [r.f64()?, r.f64()?, r.f64()?];
    if p.iter().all(|v| v.is_finite()) {
        Ok(p)
    } else {
        Err(DecodeError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_packets_round_trip_and_reject_truncation() {
        let packet = C2S::Chat {
            text: "🙂".repeat(256),
        };
        let mut bytes = packet.encode();
        assert_eq!(&bytes[..3], &[0x12, 0x80, 0x08]);
        assert_eq!(C2S::decode(&bytes), Ok(packet));
        for end in 0..bytes.len() {
            assert_eq!(C2S::decode(&bytes[..end]), Err(DecodeError));
        }
        bytes.push(0);
        assert_eq!(C2S::decode(&bytes), Err(DecodeError));

        for kind in [
            ChatKind::Player,
            ChatKind::Join,
            ChatKind::Leave,
            ChatKind::System,
            ChatKind::Emote,
            ChatKind::WhisperFrom,
            ChatKind::WhisperTo,
        ] {
            let packet = S2C::Chat {
                kind,
                sender: "🙂".repeat(16),
                text: if kind == ChatKind::Player {
                    "🙂".repeat(256)
                } else {
                    String::new()
                },
            };
            let mut bytes = packet.encode();
            assert_eq!(&bytes[..3], &[0x13, kind as u8, 64]);
            assert_eq!(S2C::decode(&bytes), Ok(packet));
            for end in 0..bytes.len() {
                assert_eq!(S2C::decode(&bytes[..end]), Err(DecodeError));
            }
            bytes.push(0);
            assert_eq!(S2C::decode(&bytes), Err(DecodeError));
        }
    }

    #[test]
    fn chat_packets_reject_invalid_lengths_utf8_and_kind() {
        assert_eq!(C2S::decode(&[0x12, 1, 0xff]), Err(DecodeError));
        assert_eq!(
            C2S::decode(&[0x12, 0x80, 0x80, 0x80, 0x80, 0x10]),
            Err(DecodeError)
        );
        assert_eq!(
            C2S::decode(
                &C2S::Chat {
                    text: "a".repeat(1025)
                }
                .encode()
            ),
            Err(DecodeError)
        );
        for bytes in [
            &[0x13, 7, 0, 0][..],
            &[0x13, 0, 1, 0xff, 0],
            &[0x13, 0, 0, 1, 0xff],
        ] {
            assert_eq!(S2C::decode(bytes), Err(DecodeError));
        }
        for (sender, text) in [
            ("a".repeat(65), String::new()),
            (String::new(), "a".repeat(1025)),
        ] {
            assert_eq!(
                S2C::decode(
                    &S2C::Chat {
                        kind: ChatKind::Player,
                        sender,
                        text
                    }
                    .encode()
                ),
                Err(DecodeError)
            );
        }
    }

    #[test]
    fn system_emote_and_whisper_chat_round_trip_and_unknown_kinds_fail() {
        for (kind, sender, text) in [
            (ChatKind::System, "", "サーバーからの通知"),
            (ChatKind::Emote, "あなた", "手を振る"),
            (ChatKind::WhisperFrom, "アリス", "ひそひそ"),
            (ChatKind::WhisperTo, "ボブ", "ひそひそ"),
            (ChatKind::System, "", ""),
        ] {
            let packet = S2C::Chat {
                kind,
                sender: sender.to_owned(),
                text: text.to_owned(),
            };
            let bytes = packet.encode();
            assert_eq!(bytes[1], kind as u8);
            assert_eq!(S2C::decode(&bytes), Ok(packet.clone()));
            for end in 0..bytes.len() {
                assert_eq!(S2C::decode(&bytes[..end]), Err(DecodeError));
            }
            let mut trailing = bytes;
            trailing.push(0);
            assert_eq!(S2C::decode(&trailing), Err(DecodeError));
        }
        assert_eq!(
            S2C::decode(&[0x13, ChatKind::System as u8, 0, 0]),
            Ok(S2C::Chat {
                kind: ChatKind::System,
                sender: String::new(),
                text: String::new(),
            })
        );
        assert_eq!(S2C::decode(&[0x13, 7, 0, 0]), Err(DecodeError));
        assert_eq!(S2C::decode(&[0x13, 255, 0, 0]), Err(DecodeError));
    }

    #[test]
    fn cancel_using_item_round_trips_and_rejects_payloads() {
        let packet = C2S::CancelUsingItem;
        assert_eq!(packet.encode(), [0x11]);
        assert_eq!(C2S::decode(&[0x11]), Ok(packet));
        assert!(C2S::decode(&[0x11, 0]).is_err());
        assert!(C2S::decode(&[0x11, 255]).is_err());
    }

    #[test]
    fn player_status_and_respawn_round_trip_and_reject_invalid_bytes() {
        assert_eq!(C2S::Respawn.encode(), [id::C2S_RESPAWN]);
        assert_eq!(C2S::decode(&[id::C2S_RESPAWN]), Ok(C2S::Respawn));
        assert!(C2S::decode(&[id::C2S_RESPAWN, 0]).is_err());
        for (packet, tag) in [(C2S::UseItem, 0x0d), (C2S::StopUsingItem, 0x0e)] {
            assert_eq!(packet.encode(), [tag]);
            assert_eq!(C2S::decode(&[tag]), Ok(packet));
            assert!(C2S::decode(&[tag, 0]).is_err());
        }

        for cause in 0..=6 {
            let (health, air, dead) = if cause == 0 {
                (MAX_HEALTH, MAX_AIR, false)
            } else {
                (0, 0, true)
            };
            let packet = S2C::PlayerStatus {
                health,
                air,
                dead,
                cause,
                food: (cause * 5).min(MAX_FOOD),
            };
            assert_eq!(S2C::decode(&packet.encode()), Ok(packet));
        }
        let valid = PlayerVitals::default().packet().encode();
        assert_eq!(valid, [id::S2C_PLAYER_STATUS, 20, 1, 44, 0, 0, 20]);
        for len in 0..valid.len() {
            assert!(S2C::decode(&valid[..len]).is_err());
        }
        for (index, value) in [
            (1, 21),
            (1, 0),
            (3, 45),
            (4, 2),
            (4, 1),
            (5, 1),
            (5, 5),
            (6, 21),
        ] {
            let mut invalid = valid.clone();
            invalid[index] = value;
            assert!(S2C::decode(&invalid).is_err(), "{index} = {value}");
        }
        let mut no_cause = valid;
        no_cause[1] = 0;
        no_cause[4] = 1;
        assert!(S2C::decode(&no_cause).is_err());
        no_cause[5] = 9;
        assert!(S2C::decode(&no_cause).is_err());
    }

    #[test]
    fn every_packet_round_trips() {
        let c2s = [
            C2S::DigStart {
                x: i32::MIN,
                y: 50,
                z: i32::MAX,
            },
            C2S::DigAbort,
            C2S::DropItem {
                dir: [0.0, 1.0, 0.0],
            },
            C2S::SelectSlot { slot: 8 },
            C2S::CreativeSetSlot {
                slot: 35,
                item: 1,
                count: 64,
            },
            C2S::CreativeSetSlot {
                slot: 0,
                item: 0,
                count: 0,
            },
            C2S::Teleport {
                x: 123.0,
                y: 80.0,
                z: -321.0,
            },
            C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 8,
            },
            C2S::PlayerPos {
                x: -1.5,
                y: 70.25,
                z: 1e6,
                yaw: 359.5,
                pitch: -90.0,
            },
            C2S::SetBlock {
                x: -30_000_000,
                y: -64,
                z: 29_999_999,
                state: 9,
            },
        ];
        for p in c2s {
            assert_eq!(C2S::decode(&p.encode()), Ok(p));
        }
        let s2c = [
            S2C::DigProgress {
                player: u32::MAX,
                x: -1,
                y: 80,
                z: 2,
                stage: 0,
            },
            S2C::DigProgress {
                player: 1,
                x: 0,
                y: 0,
                z: 0,
                stage: 9,
            },
            S2C::DigProgress {
                player: 1,
                x: 0,
                y: 0,
                z: 0,
                stage: 255,
            },
            S2C::EntitySpawn {
                id: 1,
                kind: 0,
                item: 1,
                count: 2,
                damage: 0,
                x: 1.0,
                y: 2.0,
                z: 3.0,
            },
            S2C::EntityMove {
                id: 1,
                x: 2.0,
                y: 3.0,
                z: 4.0,
            },
            S2C::EntityCount { id: 1, count: 3 },
            S2C::EntityRemove { id: 1 },
            S2C::Inventory {
                furnace: [None; 3],
                burn: 0,
                total: 0,
                progress: 0,
                screen: 0,
                table: [None; 9],
                selected: 8,
                slots: vec![Some((1, 64, 0)); 36],
                crafting: [None; 4],
                result: None,
                cursor: None,
            },
            S2C::PlayerCorrect {
                x: 0.5,
                y: 65.0,
                z: -0.5,
            },
            S2C::Welcome {
                seed: i64::MIN,
                game_time: 42,
                spawn: [0.5, 65.0, 0.5],
                view_distance: 6,
                game_mode: 0,
            },
            S2C::ChunkData {
                cx: -2,
                cz: 3,
                data: vec![1, 2, 3, 4, 5],
            },
            S2C::UnloadChunk { cx: 7, cz: -7 },
            S2C::BlockUpdate {
                x: 1,
                y: 2,
                z: 3,
                state: 4,
            },
            S2C::TimeUpdate {
                game_time: 1 << 40,
                day_time: 6000,
            },
            S2C::Explosion {
                center: [1.5, 64.25, -2.5],
            },
            S2C::PlayerSpawn {
                id: 4,
                name: "プレイヤー".to_owned(),
                pos: [0.5, 65.0, 0.5],
                yaw: 180.0,
                pitch: -15.0,
            },
            S2C::PlayerMove {
                id: 4,
                pos: [1.5, 65.0, 0.5],
                yaw: 90.0,
                pitch: 0.0,
            },
            S2C::PlayerRemove { id: 4 },
        ];
        for p in s2c {
            assert_eq!(S2C::decode(&p.encode()), Ok(p));
        }
    }

    #[test]
    fn crafting_packets_round_trip_and_reject_out_of_range_values() {
        for packet in [
            C2S::CloseInventory,
            C2S::ClickSlot {
                slot: 40,
                button: 1,
                shift: true,
            },
            C2S::ClickSlot {
                slot: 0,
                button: 0,
                shift: false,
            },
        ] {
            assert_eq!(C2S::decode(&packet.encode()), Ok(packet));
        }
        for bytes in [
            vec![id::C2S_CLICK_SLOT, 54, 0, 0],
            vec![id::C2S_CLICK_SLOT, 0, 2, 0],
            vec![id::C2S_CLICK_SLOT, 0, 0, 2],
            vec![id::C2S_CLOSE_INVENTORY, 0],
        ] {
            assert!(C2S::decode(&bytes).is_err());
        }
        let packet = S2C::Inventory {
            furnace: [None; 3],
            burn: 0,
            total: 0,
            progress: 0,
            screen: 0,
            table: [None; 9],
            selected: 3,
            slots: vec![None; 36],
            crafting: [Some((8, 2, 0)), None, Some((5, 3, 0)), None],
            result: Some((43, 4, 0)),
            cursor: Some((44, 1, 0)),
        };
        let bytes = packet.encode();
        assert_eq!(S2C::decode(&bytes), Ok(packet));
        for offset in [183, 188, 193, 198, 203, 208] {
            let mut bad = bytes.clone();
            bad[offset + 2] = 65;
            assert!(S2C::decode(&bad).is_err());
        }
    }

    #[test]
    fn protocol_14_attack_and_mob_hurt_round_trip() {
        let id = 0x8123_4567;
        let attack = C2S::Attack { id };
        let hurt = S2C::MobHurt { id };
        let attack_bytes = attack.encode();
        let hurt_bytes = hurt.encode();
        assert_eq!(attack_bytes, [0x10, 0x81, 0x23, 0x45, 0x67]);
        assert_eq!(hurt_bytes, [0x0f, 0x81, 0x23, 0x45, 0x67]);
        assert_eq!(C2S::decode(&attack_bytes), Ok(attack));
        assert_eq!(S2C::decode(&hurt_bytes), Ok(hurt));
        for len in 0..5 {
            assert!(C2S::decode(&attack_bytes[..len]).is_err());
            assert!(S2C::decode(&hurt_bytes[..len]).is_err());
        }
        assert!(C2S::decode(&[0x10, 0, 0, 0, 1, 0]).is_err());
        assert!(S2C::decode(&[0x0f, 0, 0, 0, 1, 0]).is_err());
        assert!(S2C::decode(&[0x0f, 0, 0, 0, 0]).is_err());
    }

    #[test]
    fn protocol_13_mob_packets_round_trip_and_validate_fields() {
        assert_eq!(PROTOCOL_VERSION, 30);
        let spawn = S2C::MobSpawn {
            id: u32::MAX,
            kind: MobKind::Cow,
            x: 12.25,
            y: -60.0,
            z: -8.75,
            yaw: 90.0,
        };
        let movement = S2C::MobMove {
            id: u32::MAX,
            x: 12.375,
            y: -60.0,
            z: -8.75,
            yaw: 270.5,
        };
        for (packet, tag, len) in [(spawn, 0x0d, 34), (movement, 0x0e, 33)] {
            let bytes = packet.encode();
            assert_eq!((bytes[0], bytes.len()), (tag, len));
            assert_eq!(S2C::decode(&bytes), Ok(packet));
            for end in 0..len {
                assert!(S2C::decode(&bytes[..end]).is_err());
            }
            for (offset, invalid) in [
                (1, &[0; 4][..]),
                (len - 28, &f64::INFINITY.to_be_bytes()),
                (len - 4, &f32::NAN.to_be_bytes()),
            ] {
                let mut bad = bytes.clone();
                bad[offset..offset + invalid.len()].copy_from_slice(invalid);
                assert!(S2C::decode(&bad).is_err());
            }
            if tag == 0x0d {
                assert_eq!(bytes[5], 0);
                let mut bad = bytes.clone();
                bad[5] = 7;
                assert!(S2C::decode(&bad).is_err());
            }
            let mut trailing = bytes;
            trailing.push(0);
            assert!(S2C::decode(&trailing).is_err());
        }
    }

    #[test]
    fn protocol_15_pig_spawn_round_trips() {
        let spawn = S2C::MobSpawn {
            id: 7,
            kind: MobKind::Pig,
            x: 12.25,
            y: -60.0,
            z: -8.75,
            yaw: 90.0,
        };
        let bytes = spawn.encode();
        assert_eq!(bytes[5], 1);
        assert_eq!(S2C::decode(&bytes), Ok(spawn));
    }

    #[test]
    fn protocol_16_chicken_spawn_round_trips() {
        let spawn = S2C::MobSpawn {
            id: 8,
            kind: MobKind::Chicken,
            x: 12.25,
            y: -60.0,
            z: -8.75,
            yaw: 90.0,
        };
        let bytes = spawn.encode();
        assert_eq!(bytes[5], 2);
        assert_eq!(S2C::decode(&bytes), Ok(spawn));
    }

    #[test]
    fn protocol_17_sheep_spawn_round_trips() {
        let spawn = S2C::MobSpawn {
            id: 9,
            kind: MobKind::Sheep,
            x: 12.25,
            y: -60.0,
            z: -8.75,
            yaw: 90.0,
        };
        let bytes = spawn.encode();
        assert_eq!(bytes[5], 3);
        assert_eq!(S2C::decode(&bytes), Ok(spawn));
    }

    #[test]
    fn protocol_18_zombie_spawn_round_trips_and_rejects_unknown_kind() {
        let spawn = S2C::MobSpawn {
            id: 10,
            kind: MobKind::Zombie,
            x: 12.25,
            y: -60.0,
            z: -8.75,
            yaw: 90.0,
        };
        let mut bytes = spawn.encode();
        assert_eq!((bytes.len(), bytes[5]), (34, 4));
        assert_eq!(S2C::decode(&bytes), Ok(spawn));
        bytes[5] = 7;
        assert!(S2C::decode(&bytes).is_err());
    }

    #[test]
    fn protocol_19_skeleton_and_arrows_round_trip_and_validate_fields() {
        let skeleton = S2C::MobSpawn {
            id: 11,
            kind: MobKind::Skeleton,
            x: 12.25,
            y: -60.0,
            z: -8.75,
            yaw: 90.0,
        };
        let bytes = skeleton.encode();
        assert_eq!((bytes.len(), bytes[5]), (34, 5));
        assert_eq!(S2C::decode(&bytes), Ok(skeleton));

        let status = PlayerVitals {
            health: 0,
            dead: true,
            cause: DeathCause::Arrow,
            ..PlayerVitals::default()
        }
        .packet();
        let bytes = status.encode();
        assert_eq!(bytes[5], 7);
        assert_eq!(S2C::decode(&bytes), Ok(status));

        let id = u32::MAX;
        let pos = [12.25, -60.0, -8.75];
        let velocity = [0.25, -0.5, 1.0];
        for (tag, packet, flag) in [
            (
                0x10,
                S2C::ArrowSpawn {
                    id,
                    pos,
                    velocity,
                    fresh: true,
                },
                Some(1),
            ),
            (
                0x10,
                S2C::ArrowSpawn {
                    id,
                    pos,
                    velocity,
                    fresh: false,
                },
                Some(0),
            ),
            (0x11, S2C::ArrowMove { id, pos, velocity }, None),
        ] {
            let mut bytes = packet.encode();
            assert_eq!((bytes[0], bytes.get(53).copied()), (tag, flag));
            assert_eq!(bytes.len(), 53 + usize::from(flag.is_some()));
            assert_eq!(S2C::decode(&bytes), Ok(packet));
            for end in 0..bytes.len() {
                assert!(S2C::decode(&bytes[..end]).is_err());
            }
            let mut bad = bytes.clone();
            bad[1..5].fill(0);
            assert!(S2C::decode(&bad).is_err());
            for offset in (5..53).step_by(8) {
                for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                    let mut bad = bytes.clone();
                    bad[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
                    assert!(S2C::decode(&bad).is_err());
                }
            }
            if flag.is_some() {
                let mut bad = bytes.clone();
                bad[53] = 2;
                assert!(S2C::decode(&bad).is_err());
            }
            bytes.push(0);
            assert!(S2C::decode(&bytes).is_err());
        }
    }

    #[test]
    fn protocol_20_creeper_fuse_and_explosion_round_trip_and_reject_invalid_values() {
        let spawn = S2C::MobSpawn {
            id: 12,
            kind: MobKind::Creeper,
            x: 4.5,
            y: -60.0,
            z: 8.5,
            yaw: 180.0,
        };
        let mut bytes = spawn.encode();
        assert_eq!((bytes.len(), bytes[5]), (34, 6));
        assert_eq!(S2C::decode(&bytes), Ok(spawn));
        bytes[5] = 7;
        assert!(S2C::decode(&bytes).is_err());

        for ticks in [0, 1, 30] {
            let packet = S2C::MobFuse { id: 12, ticks };
            let mut bytes = packet.encode();
            assert_eq!((bytes[0], bytes.len(), bytes[5]), (0x12, 6, ticks));
            assert_eq!(S2C::decode(&bytes), Ok(packet));
            for end in 0..bytes.len() {
                assert!(S2C::decode(&bytes[..end]).is_err());
            }
            bytes.push(0);
            assert!(S2C::decode(&bytes).is_err());
        }
        assert!(S2C::decode(&[0x12, 0, 0, 0, 0, 1]).is_err());
        assert!(S2C::decode(&[0x12, 0, 0, 0, 12, 31]).is_err());

        let status = PlayerVitals {
            health: 0,
            dead: true,
            cause: DeathCause::Explosion,
            ..PlayerVitals::default()
        }
        .packet();
        let mut bytes = status.encode();
        assert_eq!(bytes[5], 8);
        assert_eq!(S2C::decode(&bytes), Ok(status));
        bytes[5] = 9;
        assert!(S2C::decode(&bytes).is_err());
    }

    #[test]
    fn protocol_25_knockback_and_mob_burning_round_trip_and_reject_invalid_values() {
        assert_eq!(PROTOCOL_VERSION, 30);
        let packet = S2C::PlayerKnockback {
            velocity: [0.4, 0.36, -0.2],
        };
        let bytes = packet.encode();
        assert_eq!((bytes[0], bytes.len()), (0x14, 25));
        assert_eq!(S2C::decode(&bytes), Ok(packet));
        for end in 0..bytes.len() {
            assert!(S2C::decode(&bytes[..end]).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(S2C::decode(&trailing).is_err());
        for offset in (1..25).step_by(8) {
            for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut bad = bytes.clone();
                bad[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
                assert!(S2C::decode(&bad).is_err());
            }
        }

        for (burning, flag) in [(false, 0), (true, 1)] {
            let packet = S2C::MobBurning { id: 12, burning };
            let mut bytes = packet.encode();
            assert_eq!((bytes[0], bytes.len(), bytes[5]), (0x15, 6, flag));
            assert_eq!(S2C::decode(&bytes), Ok(packet.clone()));
            for end in 0..bytes.len() {
                assert!(S2C::decode(&bytes[..end]).is_err());
            }
            bytes.push(0);
            assert!(S2C::decode(&bytes).is_err());
        }
        assert!(S2C::decode(&[0x15, 0, 0, 0, 0, 1]).is_err());
        assert!(S2C::decode(&[0x15, 0, 0, 0, 12, 2]).is_err());
    }

    #[test]
    fn protocol_26_explosion_round_trips_and_rejects_invalid_values() {
        assert_eq!(PROTOCOL_VERSION, 30);
        let packet = S2C::Explosion {
            center: [4.5, 1.85, -8.25],
        };
        let bytes = packet.encode();
        assert_eq!((bytes[0], bytes.len()), (0x16, 25));
        assert_eq!(S2C::decode(&bytes), Ok(packet));
        for end in 0..bytes.len() {
            assert!(S2C::decode(&bytes[..end]).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(S2C::decode(&trailing).is_err());
        for offset in (1..25).step_by(8) {
            for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut bad = bytes.clone();
                bad[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
                assert!(S2C::decode(&bad).is_err());
            }
        }
    }

    #[test]
    fn protocol_27_player_packets_round_trip_and_reject_invalid_values() {
        assert_eq!(PROTOCOL_VERSION, 30);
        let name = "🙂".repeat(16);
        assert_eq!(name.len(), 64);
        let pos = [12.25, -60.0, -8.75];
        let spawn = S2C::PlayerSpawn {
            id: u32::MAX,
            name: name.clone(),
            pos,
            yaw: 90.0,
            pitch: -45.5,
        };
        let movement = S2C::PlayerMove {
            id: u32::MAX,
            pos,
            yaw: 270.5,
            pitch: 10.0,
        };
        let remove = S2C::PlayerRemove { id: u32::MAX };
        let spawn_bytes = spawn.encode();
        let move_bytes = movement.encode();
        let remove_bytes = remove.encode();
        assert_eq!(
            (spawn_bytes[0], spawn_bytes.len(), spawn_bytes[5]),
            (0x17, 102, 64)
        );
        assert_eq!((move_bytes[0], move_bytes.len()), (0x18, 37));
        assert_eq!(remove_bytes, [0x19, 0xff, 0xff, 0xff, 0xff]);
        for (packet, bytes) in [
            (spawn, spawn_bytes.clone()),
            (movement, move_bytes.clone()),
            (remove, remove_bytes.clone()),
        ] {
            assert_eq!(S2C::decode(&bytes), Ok(packet));
            for end in 0..bytes.len() {
                assert!(S2C::decode(&bytes[..end]).is_err());
            }
            let mut trailing = bytes;
            trailing.push(0);
            assert!(S2C::decode(&trailing).is_err());
        }

        let empty = S2C::PlayerSpawn {
            id: 1,
            name: String::new(),
            pos,
            yaw: -90.0,
            pitch: 90.0,
        };
        assert_eq!(S2C::decode(&empty.encode()), Ok(empty));

        assert!(S2C::decode(
            &S2C::PlayerSpawn {
                id: 1,
                name: "a".repeat(65),
                pos,
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode()
        )
        .is_err());
        assert!(S2C::decode(&[0x17, 0, 0, 0, 1, 1, 0xff]).is_err());
        for (tag, bytes) in [
            (0x17u8, spawn_bytes.clone()),
            (0x18, move_bytes.clone()),
            (0x19, remove_bytes.clone()),
        ] {
            let mut zero = bytes.clone();
            zero[1..5].fill(0);
            assert!(S2C::decode(&zero).is_err(), "id 0 tag {tag}");
        }
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for offset in [5, 13, 21] {
                let mut bad = move_bytes.clone();
                bad[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
                assert!(S2C::decode(&bad).is_err());
            }
        }
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for offset in [29, 33] {
                let mut bad = move_bytes.clone();
                bad[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
                assert!(S2C::decode(&bad).is_err());
            }
        }
    }

    #[test]
    fn use_bucket_keeps_packet_0f() {
        let packet = C2S::UseBucket {
            x: i32::MIN,
            y: -64,
            z: i32::MAX,
        };
        let mut bytes = packet.encode();
        assert_eq!(bytes[0], 0x0f);
        assert_eq!(bytes.len(), 13);
        assert_eq!(C2S::decode(&bytes), Ok(packet));
        for end in 0..bytes.len() {
            assert!(C2S::decode(&bytes[..end]).is_err());
        }
        bytes.push(0);
        assert!(C2S::decode(&bytes).is_err());
    }

    #[test]
    fn table_packets_validate_screen_stacks_and_exact_lengths() {
        let use_block = C2S::UseBlock {
            x: i32::MIN,
            y: -64,
            z: i32::MAX,
        };
        let bytes = use_block.encode();
        assert_eq!(C2S::decode(&bytes), Ok(use_block));
        for end in 0..bytes.len() {
            assert!(C2S::decode(&bytes[..end]).is_err());
        }
        let mut extra = bytes;
        extra.push(0);
        assert!(C2S::decode(&extra).is_err());
        for slot in 41..=50 {
            let p = C2S::ClickSlot {
                slot,
                button: 1,
                shift: true,
            };
            assert_eq!(C2S::decode(&p.encode()), Ok(p));
        }
        let p = S2C::Inventory {
            furnace: [None; 3],
            burn: 0,
            total: 0,
            progress: 0,
            screen: 1,
            table: [Some((5, 3, 0)); 9],
            selected: 0,
            slots: vec![None; 36],
            crafting: [None; 4],
            result: Some((5, 4, 0)),
            cursor: None,
        };
        let bytes = p.encode();
        assert_eq!(S2C::decode(&bytes), Ok(p));
        for screen in 3..=255 {
            let mut bad = bytes.clone();
            bad[213] = screen;
            assert!(S2C::decode(&bad).is_err());
        }
        for offset in (214..259).step_by(5) {
            for (item, count) in [(0u16, 1), (u16::MAX, 1), (5, 0), (5, 65)] {
                let mut bad = bytes.clone();
                bad[offset..offset + 2].copy_from_slice(&item.to_be_bytes());
                bad[offset + 2] = count;
                assert!(S2C::decode(&bad).is_err());
            }
        }
        for end in 0..bytes.len() {
            assert!(S2C::decode(&bytes[..end]).is_err());
        }
        let mut extra = bytes;
        extra.push(0);
        assert!(S2C::decode(&extra).is_err());
    }
    #[test]
    fn furnace_packet_checks_stacks_timers_and_inactive_payload() {
        let p = S2C::Inventory {
            furnace: [
                Some((items_id("iron_ore"), 3, 0)),
                None,
                Some((items_id("iron_ingot"), 1, 0)),
            ],
            burn: 1387,
            total: MAX_FURNACE_DISPLAY_TICKS,
            progress: 53,
            screen: 2,
            table: [None; 9],
            selected: 0,
            slots: vec![None; 36],
            crafting: [None; 4],
            result: None,
            cursor: None,
        };
        fn items_id(name: &str) -> u16 {
            world::items::by_name(name).unwrap()
        }
        let bytes = p.encode();
        assert_eq!(S2C::decode(&bytes), Ok(p));
        for (offset, value) in [
            (213, 0),
            (259, 255),
            (261, 0),
            (274, 255),
            (276, 255),
            (278, 255),
        ] {
            let mut bad = bytes.clone();
            bad[offset] = value;
            assert!(S2C::decode(&bad).is_err(), "{offset}");
        }
    }
    #[test]
    fn inventory_packet_rejects_malformed_lengths_and_values() {
        let p = S2C::Inventory {
            furnace: [None; 3],
            burn: 0,
            total: 0,
            progress: 0,
            screen: 0,
            table: [None; 9],
            selected: 0,
            slots: vec![Some((1, 64, 0)); 36],
            crafting: [None; 4],
            result: None,
            cursor: None,
        };
        let bytes = p.encode();
        for (index, value) in [(1, 9), (2, 35), (2, 37), (3, 255), (5, 0), (5, 65)] {
            let mut bad = bytes.clone();
            bad[index] = value;
            assert!(S2C::decode(&bad).is_err());
        }
        let mut bad = bytes.clone();
        bad.push(0);
        assert!(S2C::decode(&bad).is_err());
        assert!(S2C::decode(&bytes[..bytes.len() - 1]).is_err());
        let p = S2C::Inventory {
            furnace: [None; 3],
            burn: 0,
            total: 0,
            progress: 0,
            screen: 0,
            table: [None; 9],
            selected: 8,
            slots: vec![None; 36],
            crafting: [None; 4],
            result: None,
            cursor: None,
        };
        assert_eq!(S2C::decode(&p.encode()), Ok(p));
        let mut bad = S2C::Inventory {
            furnace: [None; 3],
            burn: 0,
            total: 0,
            progress: 0,
            screen: 0,
            table: [None; 9],
            selected: 0,
            slots: vec![None; 36],
            crafting: [None; 4],
            result: None,
            cursor: None,
        }
        .encode();
        bad[5] = 1;
        assert!(S2C::decode(&bad).is_err());
        assert!(C2S::decode(&C2S::SelectSlot { slot: 9 }.encode()).is_err());
        for (slot, item, count) in [(36, 1, 1), (0, 65535, 1), (0, 1, 0), (0, 1, 65)] {
            assert!(C2S::decode(&C2S::CreativeSetSlot { slot, item, count }.encode()).is_err());
        }
    }
    #[test]
    fn protocol_30_round_trips_use_entity_sheep_appearance_and_shear() {
        assert_eq!(PROTOCOL_VERSION, 30);
        let id = 0x8000_0001;
        let use_entity = C2S::UseEntity { id };
        assert_eq!(use_entity.encode(), [0x13, 0x80, 0, 0, 1]);
        assert_eq!(C2S::decode(&use_entity.encode()), Ok(use_entity));
        assert!(C2S::decode(&[0x13, 0, 0, 0]).is_err());

        for color in [
            WoolColor::White,
            WoolColor::Gray,
            WoolColor::Brown,
            WoolColor::Black,
        ] {
            for sheared in [false, true] {
                let packet = S2C::SheepAppearance { id, color, sheared };
                let bytes = packet.encode();
                assert_eq!(bytes, [0x1b, 0x80, 0, 0, 1, color as u8, u8::from(sheared)]);
                assert_eq!(S2C::decode(&bytes), Ok(packet));
            }
        }
        for bytes in [
            [0x1b, 0, 0, 0, 1, 4, 0],
            [0x1b, 0, 0, 0, 1, 0, 2],
            [0x1b, 0, 0, 0, 0, 0, 0],
        ] {
            assert!(S2C::decode(&bytes).is_err());
        }
        assert_eq!(S2C::Shear.encode(), [0x1c]);
        assert_eq!(S2C::decode(&[0x1c]), Ok(S2C::Shear));
        assert!(S2C::decode(&[0x1c, 0]).is_err());
    }

    #[test]
    fn protocol_29_round_trips_damage_and_tool_break() {
        let item = world::items::by_name("bow").unwrap();
        let stack = Some((item, 1, 127));
        let mut slots = vec![None; 36];
        slots[0] = stack;
        let inventory = |slots| S2C::Inventory {
            furnace: [stack, None, None],
            burn: 0,
            total: 0,
            progress: 0,
            screen: 2,
            table: [stack; 9],
            selected: 0,
            slots,
            crafting: [stack; 4],
            result: None,
            cursor: stack,
        };
        let entity = |item, damage| S2C::EntitySpawn {
            id: 1,
            kind: 0,
            item,
            count: 1,
            damage,
            x: 0.0,
            y: 1.0,
            z: 2.0,
        };
        for packet in [inventory(slots.clone()), entity(item, 127), S2C::ToolBreak] {
            assert_eq!(S2C::decode(&packet.encode()), Ok(packet));
        }
        assert_eq!(S2C::ToolBreak.encode(), [0x1a]);
        for (item, damage) in [(item, 128), (1, 1)] {
            slots[0] = Some((item, 1, damage));
            assert!(S2C::decode(&inventory(slots.clone()).encode()).is_err());
            assert!(S2C::decode(&entity(item, damage).encode()).is_err());
        }
    }

    #[test]
    fn egg_packets_round_trip_and_reject_invalid_coordinates_and_flags() {
        let pos = [2.5, 6.0, -3.125];
        let spawn = S2C::EggSpawn { id: u32::MAX, pos };
        let mut expected = vec![0x1d, 255, 255, 255, 255];
        expected.extend(pos.into_iter().flat_map(f64::to_be_bytes));
        assert_eq!(spawn.encode(), expected);
        assert_eq!(S2C::decode(&expected), Ok(spawn));
        for broken in [false, true] {
            let sound = S2C::EggSound { pos, broken };
            let mut expected = vec![0x1e];
            expected.extend(pos.into_iter().flat_map(f64::to_be_bytes));
            expected.push(u8::from(broken));
            assert_eq!(sound.encode(), expected);
            assert_eq!(S2C::decode(&expected), Ok(sound));
            assert!(S2C::decode(&expected[..25]).is_err());
            expected[25] = 2;
            assert!(S2C::decode(&expected).is_err());
        }
        for packet in [
            S2C::EggSpawn { id: 0, pos },
            S2C::EggSpawn {
                id: 1,
                pos: [f64::NAN, 2.0, 3.0],
            },
            S2C::EggSound {
                pos: [0.0, f64::INFINITY, 0.0],
                broken: false,
            },
        ] {
            assert!(S2C::decode(&packet.encode()).is_err());
        }
    }

    #[test]
    fn entity_packets_reject_invalid_values_and_lengths() {
        let valid = S2C::EntitySpawn {
            id: 1,
            kind: 0,
            item: 1,
            count: 1,
            damage: 0,
            x: 0.0,
            y: 1.0,
            z: 2.0,
        }
        .encode();
        for (index, value) in [(5, 1), (6, 255), (8, 0), (8, 65)] {
            let mut bad = valid.clone();
            bad[index] = value;
            assert!(S2C::decode(&bad).is_err());
        }
        for end in 0..valid.len() {
            assert!(S2C::decode(&valid[..end]).is_err());
        }
        let mut extra = valid.clone();
        extra.push(0);
        assert!(S2C::decode(&extra).is_err());
        for p in [
            S2C::EntityCount { id: 1, count: 0 },
            S2C::EntityCount { id: 1, count: 65 },
            S2C::EntityRemove { id: 0 },
            S2C::EntityMove {
                id: 1,
                x: f64::NAN,
                y: 0.0,
                z: 0.0,
            },
        ] {
            assert!(S2C::decode(&p.encode()).is_err());
        }
        assert!(C2S::decode(
            &C2S::DropItem {
                dir: [0.0, f32::INFINITY, 0.0]
            }
            .encode()
        )
        .is_err());
    }
    #[test]
    fn garbage_is_rejected_not_panicked_on() {
        assert!(C2S::decode(&[]).is_err());
        assert!(C2S::decode(&[0x7F]).is_err());
        assert!(C2S::decode(&[id::C2S_SET_BLOCK, 0, 0]).is_err());
        // Trailing bytes after a complete packet are an error.
        let mut bytes = C2S::Hello {
            protocol: 1,
            view_distance: 4,
        }
        .encode();
        bytes.push(0);
        assert!(C2S::decode(&bytes).is_err());
        assert!(S2C::decode(&[id::S2C_TIME_UPDATE, 1, 2, 3]).is_err());
    }
}

#[cfg(test)]
mod mining_tests {
    use super::*;
    #[test]
    fn invalid_progress_stages_ids_lengths_and_trailing_bytes_are_rejected() {
        for stage in 10..255 {
            assert!(S2C::decode(
                &S2C::DigProgress {
                    player: 1,
                    x: 0,
                    y: 0,
                    z: 0,
                    stage
                }
                .encode()
            )
            .is_err());
        }
        assert!(S2C::decode(
            &S2C::DigProgress {
                player: 0,
                x: 0,
                y: 0,
                z: 0,
                stage: 0
            }
            .encode()
        )
        .is_err());
        let packet = C2S::DigStart { x: 0, y: 0, z: 0 }.encode();
        for len in 0..packet.len() {
            assert!(C2S::decode(&packet[..len]).is_err());
        }
        let mut packet = C2S::DigAbort.encode();
        packet.push(0);
        assert!(C2S::decode(&packet).is_err());
        let packet = S2C::DigProgress {
            player: 1,
            x: 0,
            y: 0,
            z: 0,
            stage: 0,
        }
        .encode();
        for len in 0..packet.len() {
            assert!(S2C::decode(&packet[..len]).is_err());
        }
        let mut packet = packet;
        packet.push(0);
        assert!(S2C::decode(&packet).is_err());
    }
}
