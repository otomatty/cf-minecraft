//! Wire protocol.
//!
//! Our own binary format, carried one packet per WebSocket message (or per
//! `postMessage` in single player). Primitive encodings follow the Java
//! protocol (big-endian, VarInt), and the packet set mirrors its semantics,
//! but it is not wire compatible with the game.

use world::io::{DecodeError, Reader, Writer};
use world::BlockState;

pub const PROTOCOL_VERSION: u32 = 5;

/// Client to server.
#[derive(Clone, Debug, PartialEq)]
pub enum C2S {
    DigStart {
        x: i32,
        y: i32,
        z: i32,
    },
    DigAbort,
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
    DigProgress {
        player: u32,
        x: i32,
        y: i32,
        z: i32,
        stage: u8,
    },
    EntitySpawn {
        id: u32,
        kind: u8,
        item: u16,
        count: u8,
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
    EntityRemove {
        id: u32,
    },
    Inventory {
        selected: u8,
        slots: Vec<Option<(u16, u8)>>,
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
}

pub mod id {
    pub const C2S_DIG_START: u8 = 0x07;
    pub const C2S_DIG_ABORT: u8 = 0x08;
    pub const S2C_DIG_PROGRESS: u8 = 0x0b;
    pub const C2S_DROP_ITEM: u8 = 0x06;
    pub const S2C_ENTITY_SPAWN: u8 = 0x07;
    pub const S2C_ENTITY_MOVE: u8 = 0x08;
    pub const S2C_ENTITY_COUNT: u8 = 0x09;
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
            C2S::DigStart { x, y, z } => {
                w.u8(id::C2S_DIG_START);
                w.i32(x);
                w.i32(y);
                w.i32(z);
            }
            C2S::DigAbort => w.u8(id::C2S_DIG_ABORT),
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
            id::C2S_DIG_START => C2S::DigStart {
                x: r.i32()?,
                y: r.i32()?,
                z: r.i32()?,
            },
            id::C2S_DIG_ABORT => C2S::DigAbort,
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
            S2C::EntitySpawn {
                id: entity,
                kind,
                item,
                count,
                x,
                y,
                z,
            } => {
                w.u8(id::S2C_ENTITY_SPAWN);
                w.i32(*entity as i32);
                w.u8(*kind);
                w.u16(*item);
                w.u8(*count);
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
            S2C::EntityRemove { id: entity } => {
                w.u8(id::S2C_ENTITY_REMOVE);
                w.i32(*entity as i32);
            }

            S2C::Inventory { selected, slots } => {
                w.u8(id::S2C_INVENTORY);
                w.u8(*selected);
                w.u8(slots.len() as u8);
                for slot in slots {
                    w.u16(slot.map_or(0, |s| s.0));
                    w.u8(slot.map_or(0, |s| s.1));
                }
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
        }
        w.finish()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(bytes);
        let packet = match r.u8()? {
            id::S2C_ENTITY_SPAWN => {
                let id = entity_id(&mut r)?;
                let kind = r.u8()?;
                let item = r.u16()?;
                let count = r.u8()?;
                if kind != 0
                    || !world::items::info(item).is_some_and(|i| (1..=i.max_stack).contains(&count))
                {
                    return Err(DecodeError);
                }
                let [x, y, z] = entity_pos(&mut r)?;
                S2C::EntitySpawn {
                    id,
                    kind,
                    item,
                    count,
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
            id::S2C_ENTITY_REMOVE => S2C::EntityRemove {
                id: entity_id(&mut r)?,
            },
            id::S2C_INVENTORY => {
                let selected = r.u8()?;
                let n = r.u8()?;
                if selected >= 9 || n != 36 {
                    return Err(DecodeError);
                }
                let mut slots = Vec::with_capacity(36);
                for _ in 0..36 {
                    let item = r.u16()?;
                    let count = r.u8()?;
                    if item == 0 {
                        if count != 0 {
                            return Err(DecodeError);
                        }
                        slots.push(None);
                    } else {
                        if !world::items::info(item)
                            .is_some_and(|i| (1..=i.max_stack).contains(&count))
                        {
                            return Err(DecodeError);
                        }
                        slots.push(Some((item, count)));
                    }
                }
                S2C::Inventory { selected, slots }
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
            id::S2C_PLAYER_CORRECT => S2C::PlayerCorrect {
                x: r.f64()?,
                y: r.f64()?,
                z: r.f64()?,
            },
            id::S2C_TIME_UPDATE => S2C::TimeUpdate {
                game_time: r.i64()?,
                day_time: r.i64()?,
            },
            _ => return Err(DecodeError),
        };
        if r.remaining() != 0 {
            return Err(DecodeError);
        }
        Ok(packet)
    }
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
                selected: 8,
                slots: vec![Some((1, 64)); 36],
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
        ];
        for p in s2c {
            assert_eq!(S2C::decode(&p.encode()), Ok(p));
        }
    }

    #[test]
    fn inventory_packet_rejects_malformed_lengths_and_values() {
        let p = S2C::Inventory {
            selected: 0,
            slots: vec![Some((1, 64)); 36],
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
            selected: 8,
            slots: vec![None; 36],
        };
        assert_eq!(S2C::decode(&p.encode()), Ok(p));
        let mut bad = S2C::Inventory {
            selected: 0,
            slots: vec![None; 36],
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
    fn entity_packets_reject_invalid_values_and_lengths() {
        let valid = S2C::EntitySpawn {
            id: 1,
            kind: 0,
            item: 1,
            count: 1,
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
