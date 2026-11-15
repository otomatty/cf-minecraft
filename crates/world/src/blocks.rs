//! M0 block registry: full-cube blocks.
//!
//! State ids here are our own. The real registry (every block state of the
//! pinned game version, in the game's id order) is generated data and arrives
//! with the `registry` crate in M2.

use crate::BlockState;

pub const AIR: BlockState = 0;
pub const STONE: BlockState = 1;
pub const GRASS_BLOCK: BlockState = 2;
pub const DIRT: BlockState = 3;
pub const COBBLESTONE: BlockState = 4;
pub const OAK_PLANKS: BlockState = 5;
pub const BEDROCK: BlockState = 6;
pub const SAND: BlockState = 7;
pub const OAK_LOG: BlockState = 8;
pub const BRICKS: BlockState = 9;
pub const LAMP_BLOCK: BlockState = 10;
pub const COUNT: BlockState = 11;

/// Texture layers, in atlas order. The client generates one 16x16 image per
/// name; the mesher refers to them by index.
pub const TEXTURES: &[&str] = &[
    "stone",
    "grass_block_top",
    "grass_block_side",
    "dirt",
    "cobblestone",
    "oak_planks",
    "bedrock",
    "sand",
    "oak_log",
    "oak_log_top",
    "bricks",
    "lamp_block",
];

pub struct BlockInfo {
    /// Light absorption and emission, each in 0..=15.
    pub opacity: u8,
    pub emission: u8,
    pub name: &'static str,
    /// Texture layer per face, in `Direction` order: down, up, north, south, west, east.
    pub tex: [u16; 6],
    /// Faces whose texture is grayscale and multiplied by the biome grass colour.
    pub tint: [bool; 6],
}

const fn all(t: u16) -> [u16; 6] {
    [t; 6]
}

const NO_TINT: [bool; 6] = [false; 6];

static INFO: [BlockInfo; COUNT as usize] = [
    BlockInfo {
        opacity: 0,
        emission: 0,
        name: "air",
        tex: all(0),
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "stone",
        tex: all(0),
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "grass_block",
        tex: [3, 1, 2, 2, 2, 2],
        tint: [false, true, false, false, false, false],
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "dirt",
        tex: all(3),
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "cobblestone",
        tex: all(4),
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "oak_planks",
        tex: all(5),
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "bedrock",
        tex: all(6),
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "sand",
        tex: all(7),
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "oak_log",
        tex: [9, 9, 8, 8, 8, 8],
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 0,
        name: "bricks",
        tex: all(10),
        tint: NO_TINT,
    },
    BlockInfo {
        opacity: 15,
        emission: 15,
        name: "lamp_block",
        tex: all(11),
        tint: NO_TINT,
    },
];

#[inline]
pub fn info(state: BlockState) -> &'static BlockInfo {
    &INFO[(state as usize).min(COUNT as usize - 1)]
}

#[inline]
pub fn is_valid(state: BlockState) -> bool {
    state < COUNT
}

/// Full opaque cube: hides the faces of its neighbours and casts ambient occlusion.
#[inline]
pub fn is_opaque(state: BlockState) -> bool {
    state != AIR
}
