//! Generated stable item definitions; block state IDs are a separate namespace.
use crate::{blocks, BlockState};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ItemInfo {
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
#[cfg(test)]
mod tests {
    use super::*;
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
