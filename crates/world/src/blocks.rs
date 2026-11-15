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
pub const GLASS: BlockState = 11;
pub const OAK_LEAVES: BlockState = 12;
pub const WATER: BlockState = 13;
pub const OAK_SLAB: BlockState = 14;
pub const COBBLESTONE_SLAB: BlockState = 17;
pub const RED_FLOWER: BlockState = 20;
pub const YELLOW_FLOWER: BlockState = 21;
pub const SHORT_GRASS: BlockState = 22;
pub const COUNT: BlockState = 23;
pub const LEGACY_COUNT: BlockState = 14;

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
    "glass",
    "oak_leaves",
    "water",
    "red_flower",
    "yellow_flower",
    "short_grass",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum RenderLayer {
    Opaque,
    Cutout,
    Translucent,
}

/// Local bounds in sixteenths of a block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Box16 {
    pub min: [u8; 3],
    pub max: [u8; 3],
}
pub const FULL_BOX: Box16 = Box16 {
    min: [0; 3],
    max: [16; 3],
};
const BOTTOM: [Box16; 1] = [Box16 {
    min: [0; 3],
    max: [16, 8, 16],
}];
const TOP: [Box16; 1] = [Box16 {
    min: [0, 8, 0],
    max: [16; 3],
}];
const PLANT: [Box16; 1] = [Box16 {
    min: [5, 0, 5],
    max: [11, 10, 11],
}];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Cube,
    Boxes(&'static [Box16]),
    Cross,
}

#[derive(Clone, Copy)]
pub struct BlockInfo {
    pub model: Model,
    pub layer: RenderLayer,
    /// Full opaque cube: hides adjacent faces and blocks AO/light samples.
    pub occludes: bool,
    /// Collides with players and can be selected by raycast.
    pub solid: bool,
    /// Suppress internal faces against the same block state.
    pub cull_same: bool,
    /// Light absorption and emission, each in 0..=15.
    pub opacity: u8,
    pub emission: u8,
    pub name: &'static str,
    /// Texture layer per face, in `Direction` order: down, up, north, south, west, east.
    pub tex: [u16; 6],
    /// Faces whose grayscale texture receives grass, leaves, or water tint.
    pub tint: [bool; 6],
}

const fn all(t: u16) -> [u16; 6] {
    [t; 6]
}

const NO_TINT: [bool; 6] = [false; 6];

static INFO: [BlockInfo; COUNT as usize] = [
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: false,
        solid: false,
        cull_same: false,
        opacity: 0,
        emission: 0,
        name: "air",
        tex: all(0),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "stone",
        tex: all(0),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "grass_block",
        tex: [3, 1, 2, 2, 2, 2],
        tint: [false, true, false, false, false, false],
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "dirt",
        tex: all(3),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "cobblestone",
        tex: all(4),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "oak_planks",
        tex: all(5),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "bedrock",
        tex: all(6),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "sand",
        tex: all(7),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "oak_log",
        tex: [9, 9, 8, 8, 8, 8],
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 0,
        name: "bricks",
        tex: all(10),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Opaque,
        occludes: true,
        solid: true,
        cull_same: false,
        opacity: 15,
        emission: 15,
        name: "lamp_block",
        tex: all(11),
        tint: NO_TINT,
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Cutout,
        occludes: false,
        solid: true,
        cull_same: true,
        opacity: 0,
        emission: 0,
        name: "glass",
        tex: all(12),
        tint: [false; 6],
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Cutout,
        occludes: false,
        solid: true,
        cull_same: false,
        opacity: 1,
        emission: 0,
        name: "oak_leaves",
        tex: all(13),
        tint: [true; 6],
    },
    BlockInfo {
        model: Model::Cube,
        layer: RenderLayer::Translucent,
        occludes: false,
        solid: false,
        cull_same: true,
        opacity: 1,
        emission: 0,
        name: "water",
        tex: all(14),
        tint: [true; 6],
    },
    slab("oak_slab", 5, 0),
    slab("oak_slab", 5, 1),
    slab("oak_slab", 5, 2),
    slab("cobblestone_slab", 4, 0),
    slab("cobblestone_slab", 4, 1),
    slab("cobblestone_slab", 4, 2),
    plant("red_flower", 15, false),
    plant("yellow_flower", 16, false),
    plant("short_grass", 17, true),
];

#[inline]
pub fn info(state: BlockState) -> &'static BlockInfo {
    &INFO[if is_valid(state) {
        state as usize
    } else {
        AIR as usize
    }]
}

#[inline]
pub const fn is_valid(state: BlockState) -> bool {
    state < COUNT
}

/// Full opaque cube: hides the faces of its neighbours and casts ambient occlusion.
#[inline]
pub fn occludes(state: BlockState) -> bool {
    info(state).occludes
}

#[inline]
pub fn is_solid(state: BlockState) -> bool {
    info(state).solid
}

const fn slab(name: &'static str, texture: u16, kind: u8) -> BlockInfo {
    BlockInfo {
        name,
        tex: all(texture),
        tint: NO_TINT,
        model: match kind {
            0 => Model::Boxes(&BOTTOM),
            1 => Model::Boxes(&TOP),
            _ => Model::Cube,
        },
        layer: RenderLayer::Opaque,
        occludes: kind == 2,
        solid: true,
        cull_same: false,
        opacity: if kind == 2 { 15 } else { 0 },
        emission: 0,
    }
}
const fn plant(name: &'static str, texture: u16, tint: bool) -> BlockInfo {
    BlockInfo {
        name,
        tex: all(texture),
        tint: [tint; 6],
        model: Model::Cross,
        layer: RenderLayer::Cutout,
        occludes: false,
        solid: false,
        cull_same: false,
        opacity: 0,
        emission: 0,
    }
}

/// A block owns a contiguous range; its first state is the inventory default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    pub name: &'static str,
    pub first: BlockState,
    pub count: u16,
}
pub fn registry() -> impl Iterator<Item = Block> {
    (0..COUNT)
        .filter(|s| !matches!(*s, 15 | 16 | 18 | 19))
        .map(|first| Block {
            name: info(first).name,
            first,
            count: if matches!(first, OAK_SLAB | COBBLESTONE_SLAB) {
                3
            } else {
                1
            },
        })
}
pub fn block(state: BlockState) -> Option<Block> {
    registry().find(|b| (b.first..b.first + b.count).contains(&state))
}
pub fn properties(state: BlockState) -> &'static [(&'static str, &'static str)] {
    match state {
        14 | 17 => &[("type", "bottom")],
        15 | 18 => &[("type", "top")],
        16 | 19 => &[("type", "double")],
        _ => &[],
    }
}
pub fn state_name(state: BlockState) -> String {
    let mut name = info(state).name.to_owned();
    if let Some((key, value)) = properties(state).first() {
        name.push_str(&format!("[{key}={value}]"));
    }
    name
}
pub fn parse_state(name: &str) -> Option<BlockState> {
    (0..COUNT).find(|s| state_name(*s) == name)
}
pub fn selection_boxes(state: BlockState) -> &'static [Box16] {
    match info(state).model {
        _ if state == AIR || state == WATER || !is_valid(state) => &[],
        Model::Cube => &[FULL_BOX],
        Model::Boxes(boxes) => boxes,
        Model::Cross => &PLANT,
    }
}
pub fn collision_boxes(state: BlockState) -> &'static [Box16] {
    if is_solid(state) {
        selection_boxes(state)
    } else {
        &[]
    }
}
/// Server placement policy: any replacement is allowed; plants need support.
pub fn can_place(_old: BlockState, new: BlockState, below: BlockState) -> bool {
    is_valid(new) && (info(new).model != Model::Cross || occludes(below))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_registry_round_trip_and_legacy_ids() {
        let legacy = [
            "air",
            "stone",
            "grass_block",
            "dirt",
            "cobblestone",
            "oak_planks",
            "bedrock",
            "sand",
            "oak_log",
            "bricks",
            "lamp_block",
            "glass",
            "oak_leaves",
            "water",
        ];
        for (id, name) in legacy.into_iter().enumerate() {
            assert_eq!(parse_state(name), Some(id as u16));
            assert_eq!(block(id as u16).unwrap().count, 1);
        }
        for s in 0..COUNT {
            assert_eq!(parse_state(&state_name(s)), Some(s));
            let b = block(s).unwrap();
            assert!((b.first..b.first + b.count).contains(&s));
        }
        assert_eq!(properties(OAK_SLAB + 1), &[("type", "top")]);
        assert!(!is_valid(COUNT));
        assert!(block(u16::MAX).is_none());
    }
}
