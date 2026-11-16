//! Deterministic player inventory. Slot order is also insertion order.
use world::{
    io::{DecodeError, Reader, Writer},
    items,
};
pub const SLOT_COUNT: usize = 36;
pub const HOTBAR_COUNT: u8 = 9;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stack {
    pub item: u16,
    pub count: u8,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inventory {
    slots: [Option<Stack>; SLOT_COUNT],
    selected: u8,
}
impl Default for Inventory {
    fn default() -> Self {
        Self {
            slots: [None; SLOT_COUNT],
            selected: 0,
        }
    }
}
impl Inventory {
    pub fn creative() -> Self {
        let mut result = Self::default();
        for (i, name) in [
            "stone",
            "dirt",
            "oak_planks",
            "oak_slab",
            "oak_log",
            "glass",
            "oak_leaves",
            "water",
            "lamp_block",
        ]
        .iter()
        .enumerate()
        {
            result.slots[i] = Some(Stack {
                item: items::by_name(name).expect("default item"),
                count: 1,
            });
        }
        result
    }
    pub fn slots(&self) -> &[Option<Stack>; SLOT_COUNT] {
        &self.slots
    }
    pub fn selected(&self) -> u8 {
        self.selected
    }
    pub fn selected_stack(&self) -> Option<Stack> {
        self.slots[self.selected as usize]
    }
    pub fn select(&mut self, slot: u8) -> Result<(), DecodeError> {
        if slot >= HOTBAR_COUNT {
            return Err(DecodeError);
        }
        self.selected = slot;
        Ok(())
    }
    pub fn set(&mut self, slot: u8, stack: Option<Stack>) -> Result<(), DecodeError> {
        if slot as usize >= SLOT_COUNT || stack.is_some_and(|s| !valid(s)) {
            return Err(DecodeError);
        }
        self.slots[slot as usize] = stack;
        Ok(())
    }
    pub fn take_selected(&mut self) -> Option<u16> {
        let stack = self.slots[self.selected as usize].as_mut()?;
        let item = stack.item;
        stack.count -= 1;
        if stack.count == 0 {
            self.slots[self.selected as usize] = None;
        }
        Some(item)
    }
    pub fn add(&mut self, item: u16, mut count: u32) -> u32 {
        let Some(info) = items::info(item) else {
            return count;
        };
        for slot in self.slots.iter_mut().flatten().filter(|s| s.item == item) {
            let n = count.min((info.max_stack - slot.count) as u32) as u8;
            slot.count += n;
            count -= n as u32;
        }
        for slot in self.slots.iter_mut().filter(|s| s.is_none()) {
            if count == 0 {
                break;
            }
            let n = count.min(info.max_stack as u32) as u8;
            *slot = Some(Stack { item, count: n });
            count -= n as u32;
        }
        count
    }
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::new();
        w.u8(1);
        w.u8(self.selected);
        for slot in self.slots {
            w.u16(slot.map_or(0, |s| s.item));
            w.u8(slot.map_or(0, |s| s.count));
        }
        w.finish()
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(bytes);
        if r.u8()? != 1 {
            return Err(DecodeError);
        }
        let mut result = Self::default();
        result.select(r.u8()?)?;
        for i in 0..SLOT_COUNT {
            let item = r.u16()?;
            let count = r.u8()?;
            if item == 0 && count != 0 {
                return Err(DecodeError);
            }
            result.set(i as u8, (item != 0).then_some(Stack { item, count }))?;
        }
        if r.remaining() != 0 {
            return Err(DecodeError);
        }
        Ok(result)
    }
}
fn valid(s: Stack) -> bool {
    items::info(s.item).is_some_and(|i| (1..=i.max_stack).contains(&s.count))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn insertion_merges_before_filling_empty_slots_and_returns_overflow() {
        let mut inv = Inventory::default();
        inv.set(12, Some(Stack { item: 1, count: 60 })).unwrap();
        assert_eq!(inv.add(1, 70), 0);
        assert_eq!(inv.slots[12].unwrap().count, 64);
        assert_eq!(inv.slots[0].unwrap().count, 64);
        assert_eq!(inv.slots[1].unwrap().count, 2);
        assert_eq!(inv.add(1, 64 * 36), 130);
        assert_eq!(inv.add(u16::MAX, 3), 3);
    }
    #[test]
    fn persistence_is_strict_and_round_trips() {
        let mut inv = Inventory::creative();
        inv.select(8).unwrap();
        let bytes = inv.to_bytes();
        assert_eq!(Inventory::from_bytes(&bytes), Ok(inv));
        for (at, value) in [(0, 2), (1, 9), (2, 255), (4, 0), (4, 65), (3, 0)] {
            let mut bad = bytes.clone();
            bad[at] = value;
            assert!(Inventory::from_bytes(&bad).is_err(), "{at} {value}");
        }
        assert!(Inventory::from_bytes(&bytes[..bytes.len() - 1]).is_err());
        let mut bad = bytes;
        bad.push(0);
        assert!(Inventory::from_bytes(&bad).is_err());
    }
}
