//! Wire protocol.
//!
//! Our own binary format, carried one packet per WebSocket message (or per
//! `postMessage` in single player). Primitive encodings follow the Java
//! protocol (big-endian, VarInt), and the packet set mirrors its semantics,
//! but it is not wire compatible with the game.

use world::io::{DecodeError, Reader, Writer};
use world::BlockState;

pub const PROTOCOL_VERSION: u32 = 1;

/// Client to server.
#[derive(Clone, Debug, PartialEq)]
pub enum C2S {
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
    Welcome {
        seed: i64,
        game_time: i64,
        spawn: [f64; 3],
        view_distance: u8,
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
    TimeUpdate {
        game_time: i64,
        day_time: i64,
    },
}

pub mod id {
    pub const C2S_HELLO: u8 = 0x00;
    pub const C2S_PLAYER_POS: u8 = 0x01;
    pub const C2S_SET_BLOCK: u8 = 0x02;

    pub const S2C_WELCOME: u8 = 0x00;
    pub const S2C_CHUNK_DATA: u8 = 0x01;
    pub const S2C_UNLOAD_CHUNK: u8 = 0x02;
    pub const S2C_BLOCK_UPDATE: u8 = 0x03;
    pub const S2C_TIME_UPDATE: u8 = 0x04;
}

impl C2S {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        match *self {
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
            S2C::Welcome {
                seed,
                game_time,
                spawn,
                view_distance,
            } => {
                w.u8(id::S2C_WELCOME);
                w.i64(*seed);
                w.i64(*game_time);
                for v in spawn {
                    w.f64(*v);
                }
                w.u8(*view_distance);
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
            id::S2C_WELCOME => S2C::Welcome {
                seed: r.i64()?,
                game_time: r.i64()?,
                spawn: [r.f64()?, r.f64()?, r.f64()?],
                view_distance: r.u8()?,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_packet_round_trips() {
        let c2s = [
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
            S2C::Welcome {
                seed: i64::MIN,
                game_time: 42,
                spawn: [0.5, 65.0, 0.5],
                view_distance: 6,
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
