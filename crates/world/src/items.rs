//! Generated stable item definitions; block state IDs are a separate namespace.
use crate::{blocks, BlockState};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolKind {
    Pickaxe,
    Axe,
    Shovel,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tool {
    pub kind: ToolKind,
    pub tier: u8,
}
impl Tool {
    pub fn speed(self) -> u32 {
        [2, 4, 5, 6][usize::from(self.tier - 1)]
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ItemInfo {
    pub fuel: Option<u32>,
    pub texture: Option<&'static str>,
    pub tool: Option<Tool>,
    pub id: u16,
    pub name: &'static str,
    pub max_stack: u8,
    pub block: Option<BlockState>,
}
include!(concat!(env!("OUT_DIR"), "/items.rs"));
pub fn info(id: u16) -> Option<&'static ItemInfo> {
    ITEMS.iter().find(|item| item.id == id)
}
pub fn by_name(name: &str) -> Option<u16> {
    ITEMS
        .iter()
        .find(|item| item.name == name)
        .map(|item| item.id)
}
pub fn for_block(state: BlockState) -> Option<u16> {
    if state >= blocks::COUNT {
        return None;
    }
    ITEMS
        .iter()
        .find(|item| {
            item.block
                .is_some_and(|first| blocks::info(first).name == blocks::info(state).name)
        })
        .map(|item| item.id)
}
/// Item produced by mining; tool and tier eligibility is checked separately by `mining`.
pub fn mining_drop(state: BlockState) -> Option<u16> {
    if state == blocks::AIR || !blocks::is_valid(state) {
        return None;
    }
    MINING_DROPS
        .iter()
        .find(|(name, _)| *name == blocks::info(state).name)
        .map(|(_, item)| *item)
        .or_else(|| for_block(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mining_drop_overrides_only_the_harvested_item() {
        for (state, name) in [
            (blocks::STONE, "cobblestone"),
            (blocks::COBBLESTONE, "cobblestone"),
            (blocks::OAK_LOG, "oak_log"),
            (blocks::OAK_SLAB + 1, "oak_slab"),
        ] {
            assert_eq!(mining_drop(state), by_name(name));
        }
        assert_eq!(mining_drop(blocks::AIR), None);
        assert_eq!(mining_drop(blocks::COUNT), None);
        let stone = for_block(blocks::STONE).unwrap();
        assert_eq!(Some(stone), by_name("stone"));
        assert_eq!(info(stone).unwrap().block, Some(blocks::STONE));
    }

    #[test]
    fn every_non_air_state_has_the_named_item() {
        assert_eq!(for_block(blocks::AIR), None);
        for state in 1..blocks::COUNT {
            let id = for_block(state).unwrap();
            assert_eq!(info(id).unwrap().name, blocks::info(state).name);
            assert_eq!(by_name(blocks::info(state).name), Some(id));
        }
    }
}

/// Shared integer mining rules. None means an invalid or unbreakable state.
/// u32 accommodates twice the largest registry u16 duration.
pub fn mining(state: BlockState, held: Option<u16>) -> Option<(u32, bool)> {
    if state >= blocks::COUNT {
        return None;
    }
    let block = blocks::info(state);
    let base = u32::from(block.dig_ticks?);
    let matching = held
        .and_then(info)
        .and_then(|item| item.tool)
        .filter(|tool| Some(tool.kind) == block.tool);
    let drops = block.min_tier == 0 || matching.is_some_and(|tool| tool.tier >= block.min_tier);
    let ticks = matching.map_or(base, |tool| base.div_ceil(tool.speed()));
    Some((if drops { ticks } else { ticks * 2 }, drops))
}

#[cfg(test)]
mod mining_tests {
    use super::*;
    #[test]
    fn integer_mining_rules() {
        for (block, held, expected) in [
            (blocks::DIRT, None, Some((12, true))),
            (blocks::DIRT, Some("wooden_shovel"), Some((6, true))),
            (blocks::DIRT, Some("iron_axe"), Some((12, true))),
            (blocks::STONE, None, Some((140, false))),
            (blocks::STONE, Some("wooden_axe"), Some((140, false))),
            (blocks::STONE, Some("wooden_pickaxe"), Some((35, true))),
            (blocks::IRON_ORE, Some("wooden_pickaxe"), Some((90, false))),
            (blocks::IRON_ORE, Some("stone_pickaxe"), Some((23, true))),
            (blocks::GOLD_ORE, Some("stone_pickaxe"), Some((46, false))),
            (blocks::GOLD_ORE, Some("copper_pickaxe"), Some((18, true))),
            (blocks::GRASS_BLOCK, Some("iron_shovel"), Some((3, true))),
            (blocks::RED_FLOWER, Some("iron_pickaxe"), Some((0, true))),
            (blocks::RED_FLOWER, None, Some((0, true))),
            (blocks::BEDROCK, None, None),
        ] {
            assert_eq!(mining(block, held.and_then(by_name)), expected);
        }
    }
}
