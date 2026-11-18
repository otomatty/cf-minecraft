//! Deterministic player inventory. Slot order is also insertion order.
use protocol::PlayerVitals;
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Screen {
    #[default]
    None,
    Furnace {
        pos: [i32; 3],
    },
    CraftingTable {
        pos: [i32; 3],
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inventory {
    slots: [Option<Stack>; SLOT_COUNT],
    selected: u8,
    pub crafting: [Option<Stack>; 4],
    pub cursor: Option<Stack>,
    pub table: [Option<Stack>; 9],
    pub screen: Screen,
}
impl Default for Inventory {
    fn default() -> Self {
        Self {
            slots: [None; SLOT_COUNT],
            selected: 0,
            crafting: [None; 4],
            cursor: None,
            table: [None; 9],
            screen: Screen::None,
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
    pub fn add(&mut self, item: u16, count: u32) -> u32 {
        add_slots(&mut self.slots, item, count)
    }

    pub fn result(&self) -> Option<Stack> {
        if matches!(self.screen, Screen::Furnace { .. }) {
            return None;
        }
        matching_recipe(
            self.grid(),
            self.width(),
            self.width(),
            world::recipes::RECIPES,
        )
        .map(|r| Stack {
            item: r.item,
            count: r.count,
        })
    }
    fn width(&self) -> usize {
        if self.screen == Screen::None {
            2
        } else {
            3
        }
    }
    fn grid(&self) -> &[Option<Stack>] {
        if self.screen == Screen::None {
            &self.crafting
        } else {
            &self.table
        }
    }
    fn grid_mut(&mut self) -> &mut [Option<Stack>] {
        if self.screen == Screen::None {
            &mut self.crafting
        } else {
            &mut self.table
        }
    }
    fn consume(&mut self) {
        for slot in self.grid_mut() {
            subtract(slot, 1);
        }
    }
    pub fn click(&mut self, slot: u8, button: u8, shift: bool) -> Result<(), DecodeError> {
        if matches!(self.screen, Screen::Furnace { .. }) {
            return Err(DecodeError);
        }
        let base = if self.screen == Screen::None { 36 } else { 41 };
        let result_slot = if self.screen == Screen::None { 40 } else { 50 };
        if slot > result_slot || (slot >= 36 && slot < base) || button > 1 {
            return Err(DecodeError);
        }
        if slot == result_slot {
            while let Some(result) = self.result() {
                if shift {
                    let mut next = self.clone();
                    if next.add(result.item, u32::from(result.count)) != 0 {
                        break;
                    }
                    self.slots = next.slots;
                } else {
                    if self.cursor.is_some_and(|s| {
                        s.item != result.item
                            || u16::from(s.count) + u16::from(result.count)
                                > u16::from(items::info(s.item).unwrap().max_stack)
                    }) {
                        break;
                    }
                    self.cursor = Some(Stack {
                        item: result.item,
                        count: self.cursor.map_or(0, |s| s.count) + result.count,
                    });
                }
                self.consume();
                if !shift {
                    break;
                }
            }
            return Ok(());
        }
        let index = usize::from(slot);
        if shift {
            let source = if index < 36 {
                self.slots[index]
            } else {
                self.grid()[index - base as usize]
            };
            if let Some(stack) = source {
                let range = if index < 9 {
                    9..36
                } else if index < 36 {
                    0..9
                } else {
                    0..36
                };
                let remaining =
                    add_slots(&mut self.slots[range], stack.item, u32::from(stack.count));
                let source = if index < 36 {
                    &mut self.slots[index]
                } else if base == 36 {
                    &mut self.crafting[index - 36]
                } else {
                    &mut self.table[index - 41]
                };
                *source = (remaining != 0).then_some(Stack {
                    item: stack.item,
                    count: remaining as u8,
                });
            }
        } else {
            let target = if index < 36 {
                &mut self.slots[index]
            } else if base == 36 {
                &mut self.crafting[index - 36]
            } else {
                &mut self.table[index - 41]
            };
            match (self.cursor, *target) {
                (None, Some(s)) => {
                    let count = if button == 0 {
                        s.count
                    } else {
                        s.count.div_ceil(2)
                    };
                    self.cursor = Some(Stack {
                        item: s.item,
                        count,
                    });
                    subtract(target, count);
                }
                (Some(c), t) if t.is_none_or(|s| s.item == c.item) => {
                    let present = t.map_or(0, |s| s.count);
                    let count = (items::info(c.item).unwrap().max_stack - present)
                        .min(if button == 0 { c.count } else { 1 });
                    if count > 0 {
                        *target = Some(Stack {
                            item: c.item,
                            count: present + count,
                        });
                        subtract(&mut self.cursor, count);
                    }
                }
                (Some(_), Some(_)) => std::mem::swap(target, &mut self.cursor),
                _ => {}
            }
        }
        Ok(())
    }
    pub fn click_furnace(
        &mut self,
        f: &mut crate::furnace::Furnace,
        slot: u8,
        button: u8,
        shift: bool,
    ) -> Result<(), DecodeError> {
        if button > 1 || (36..51).contains(&slot) || slot > 53 {
            return Err(DecodeError);
        }
        if shift {
            if slot < 36 {
                if let Some(s) = self.slots[slot as usize] {
                    let target = if world::smelting::output(s.item).is_some() {
                        Some(0)
                    } else if items::info(s.item).unwrap().fuel.is_some() {
                        Some(1)
                    } else {
                        None
                    };
                    if let Some(i) = target {
                        let left = add_slots(&mut f.slots[i..=i], s.item, u32::from(s.count));
                        subtract(&mut self.slots[slot as usize], s.count - left as u8);
                        return Ok(());
                    }
                }
            } else {
                let source = &mut f.slots[(slot - 51) as usize];
                if let Some(s) = *source {
                    let left = self.add(s.item, u32::from(s.count));
                    subtract(source, s.count - left as u8);
                }
                return Ok(());
            }
        }
        if slot == 53 {
            if let Some(s) = f.slots[2] {
                if self.cursor.is_none_or(|c| c.item == s.item) {
                    let room =
                        items::info(s.item).unwrap().max_stack - self.cursor.map_or(0, |c| c.count);
                    let count = room.min(if button == 0 {
                        s.count
                    } else {
                        s.count.div_ceil(2)
                    });
                    if count > 0 {
                        self.cursor = Some(Stack {
                            item: s.item,
                            count: self.cursor.map_or(0, |c| c.count) + count,
                        });
                        subtract(&mut f.slots[2], count);
                    }
                }
            }
            return Ok(());
        }
        if slot == 52
            && self
                .cursor
                .is_some_and(|s| items::info(s.item).unwrap().fuel.is_none())
        {
            return Ok(());
        }
        // Reuse the same pickup/place/swap rules through a temporary 2x2 target.
        let screen = self.screen;
        self.screen = Screen::None;
        let saved = self.crafting;
        if slot >= 51 {
            self.crafting[0] = f.slots[(slot - 51) as usize];
        }
        let result = self.click(if slot >= 51 { 36 } else { slot }, button, shift);
        if slot >= 51 {
            f.slots[(slot - 51) as usize] = self.crafting[0];
        }
        self.crafting = saved;
        self.screen = screen;
        result
    }
    /// Returns overflow for the server to spawn, in stable grid then cursor order.
    pub fn return_crafting(&mut self) -> Vec<Stack> {
        let mut overflow = Vec::new();
        let mut stacks = self.crafting.to_vec();
        stacks.extend(self.table);
        stacks.push(self.cursor);
        self.table = [None; 9];
        self.screen = Screen::None;
        self.crafting = [None; 4];
        self.cursor = None;
        for stack in stacks.into_iter().flatten() {
            let count = self.add(stack.item, u32::from(stack.count));
            if count > 0 {
                overflow.push(Stack {
                    item: stack.item,
                    count: count as u8,
                });
            }
        }
        overflow
    }
    /// Empty the carried slots in inventory, 2×2, 3×3, then cursor order.
    pub(crate) fn take_all(&mut self) -> impl Iterator<Item = Stack> {
        self.screen = Screen::None;
        std::mem::replace(&mut self.slots, [None; SLOT_COUNT])
            .into_iter()
            .chain(std::mem::take(&mut self.crafting))
            .chain(std::mem::take(&mut self.table))
            .chain([self.cursor.take()])
            .flatten()
    }

    pub fn to_bytes(&self, vitals: PlayerVitals) -> Vec<u8> {
        let mut w = Writer::new();
        w.u8(4);
        w.u8(self.selected);
        for slot in self
            .slots
            .into_iter()
            .chain(self.crafting)
            .chain([self.cursor])
            .chain(self.table)
        {
            w.u16(slot.map_or(0, |s| s.item));
            w.u8(slot.map_or(0, |s| s.count));
        }
        vitals.write(&mut w);
        w.finish()
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<(Self, PlayerVitals), DecodeError> {
        let mut r = Reader::new(bytes);
        let version = r.u8()?;
        if !matches!(version, 1..=4) {
            return Err(DecodeError);
        }
        let mut result = Self::default();
        result.select(r.u8()?)?;
        let count =
            SLOT_COUNT + if version >= 2 { 5 } else { 0 } + if version >= 3 { 9 } else { 0 };
        for slot in result
            .slots
            .iter_mut()
            .chain(result.crafting.iter_mut())
            .chain(std::iter::once(&mut result.cursor))
            .chain(result.table.iter_mut())
            .take(count)
        {
            let item = r.u16()?;
            let count = r.u8()?;
            if item == 0 && count != 0 {
                return Err(DecodeError);
            }
            let stack = (item != 0).then_some(Stack { item, count });
            if stack.is_some_and(|s| !valid(s)) {
                return Err(DecodeError);
            }
            *slot = stack;
        }
        let vitals = if version == 4 {
            PlayerVitals::read(&mut r)?
        } else {
            PlayerVitals::default()
        };
        if r.remaining() != 0 {
            return Err(DecodeError);
        }
        Ok((result, vitals))
    }
}
pub(crate) fn valid(s: Stack) -> bool {
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
    fn persistence_preserves_transient_slots_and_reads_v1_through_v3() {
        let mut inv = Inventory::creative();
        inv.select(7).unwrap();
        inv.crafting = [
            Some(Stack { item: 8, count: 64 }),
            None,
            Some(Stack { item: 5, count: 3 }),
            Some(Stack { item: 31, count: 1 }),
        ];
        inv.cursor = Some(Stack { item: 43, count: 5 });
        inv.table[8] = Some(Stack { item: 5, count: 7 });
        let vitals = PlayerVitals::default();
        let bytes = inv.to_bytes(vitals);
        assert_eq!(bytes.len(), 157);
        assert_eq!(bytes[0], 4);
        assert_eq!(Inventory::from_bytes(&bytes), Ok((inv.clone(), vitals)));
        let mut v3 = bytes[..152].to_vec();
        v3[0] = 3;
        assert_eq!(Inventory::from_bytes(&v3), Ok((inv.clone(), vitals)));
        let mut v2 = bytes[..125].to_vec();
        v2[0] = 2;
        let mut expected_v2 = inv.clone();
        expected_v2.table = [None; 9];
        assert_eq!(Inventory::from_bytes(&v2), Ok((expected_v2, vitals)));
        let mut legacy = bytes[..110].to_vec();
        legacy[0] = 1;
        let mut expected = inv.clone();
        expected.crafting = [None; 4];
        expected.cursor = None;
        expected.table = [None; 9];
        assert_eq!(Inventory::from_bytes(&legacy), Ok((expected, vitals)));
        for data in [&bytes, &v3, &v2, &legacy] {
            for length in 0..data.len() {
                assert!(Inventory::from_bytes(&data[..length]).is_err());
            }
            let mut extra = data.clone();
            extra.push(0);
            assert!(Inventory::from_bytes(&extra).is_err());
        }
        for offset in [110, 113, 116, 119, 122, 125, 149] {
            for (item, count) in [(0u16, 1), (u16::MAX, 1), (8, 0), (8, 65), (31, 2)] {
                let mut bad = bytes.clone();
                bad[offset..offset + 2].copy_from_slice(&item.to_be_bytes());
                bad[offset + 2] = count;
                assert!(
                    Inventory::from_bytes(&bad).is_err(),
                    "{offset}: {item}/{count}"
                );
            }
        }
    }
    #[test]
    fn persistence_v4_stores_vitals_and_rejects_invalid_status() {
        use protocol::DeathCause;

        let inv = Inventory::default();
        let vitals = PlayerVitals {
            health: 0,
            air: 42,
            dead: true,
            cause: DeathCause::Void,
        };
        let save = inv.to_bytes(vitals);
        assert_eq!(&save[152..], &[0, 0, 42, 1, 4]);
        assert_eq!(Inventory::from_bytes(&save), Ok((inv, vitals)));
        for (offset, value) in [
            (152, 1),
            (152, 21),
            (153, 2),
            (155, 0),
            (155, 2),
            (156, 0),
            (156, 5),
        ] {
            let mut bad = save.clone();
            bad[offset] = value;
            assert!(Inventory::from_bytes(&bad).is_err(), "{offset} = {value}");
        }
    }
    #[test]
    fn persistence_is_strict_and_round_trips() {
        let mut inv = Inventory::creative();
        inv.select(8).unwrap();
        let vitals = PlayerVitals::default();
        let bytes = inv.to_bytes(vitals);
        assert_eq!(Inventory::from_bytes(&bytes), Ok((inv, vitals)));
        for (at, value) in [(0, 5), (1, 9), (2, 255), (4, 0), (4, 65), (3, 0)] {
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

pub(crate) fn subtract(slot: &mut Option<Stack>, count: u8) {
    if let Some(s) = slot {
        s.count -= count;
        if s.count == 0 {
            *slot = None;
        }
    }
}
fn add_slots(slots: &mut [Option<Stack>], item: u16, mut count: u32) -> u32 {
    let Some(info) = items::info(item) else {
        return count;
    };
    for slot in slots.iter_mut().flatten().filter(|s| s.item == item) {
        let n = count.min(u32::from(info.max_stack - slot.count)) as u8;
        slot.count += n;
        count -= u32::from(n);
    }
    for slot in slots.iter_mut().filter(|s| s.is_none()) {
        if count == 0 {
            break;
        }
        let n = count.min(u32::from(info.max_stack)) as u8;
        *slot = Some(Stack { item, count: n });
        count -= u32::from(n);
    }
    count
}
/// Shared matcher for any rectangular crafting grid. Counts do not affect matching.
pub fn matching_recipe<'a>(
    grid: &[Option<Stack>],
    width: usize,
    height: usize,
    recipes: &'a [world::recipes::Recipe],
) -> Option<&'a world::recipes::Recipe> {
    if width == 0 || height == 0 || grid.len() != width * height {
        return None;
    }
    let occupied: Vec<_> = grid
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.map(|_| i))
        .collect();
    let left = occupied.iter().map(|i| i % width).min()?;
    let right = occupied.iter().map(|i| i % width).max()?;
    let top = occupied.iter().map(|i| i / width).min()?;
    let bottom = occupied.iter().map(|i| i / width).max()?;
    let mut multiset: Vec<_> = grid.iter().flatten().map(|s| s.item).collect();
    multiset.sort_unstable();
    recipes.iter().find(|r| {
        if r.width == 0 {
            return r.ingredients == multiset;
        }
        r.width == right - left + 1
            && r.height == bottom - top + 1
            && (0..r.height).all(|y| {
                (0..r.width).all(|x| {
                    grid[(top + y) * width + left + x].map_or(0, |s| s.item)
                        == r.ingredients[y * r.width + x]
                })
            })
    })
}

#[cfg(test)]
mod crafting_tests {
    use super::*;
    fn stack(item: u16, count: u8) -> Option<Stack> {
        Some(Stack { item, count })
    }
    #[test]
    fn matching_trims_offsets_shapeless_and_rejects_wrong_shapes() {
        for i in 0..4 {
            let mut grid = [None; 4];
            grid[i] = stack(8, 12);
            assert_eq!(
                matching_recipe(&grid, 2, 2, world::recipes::RECIPES)
                    .unwrap()
                    .item,
                5
            );
        }
        for x in 0..2 {
            let mut grid = [None; 4];
            grid[x] = stack(5, 1);
            grid[x + 2] = stack(5, 64);
            assert_eq!(
                matching_recipe(&grid, 2, 2, world::recipes::RECIPES)
                    .unwrap()
                    .item,
                43
            );
        }
        assert!(matching_recipe(
            &[stack(5, 1), stack(5, 1), None, None],
            2,
            2,
            world::recipes::RECIPES
        )
        .is_none());
        let wide = [world::recipes::Recipe {
            width: 3,
            height: 1,
            ingredients: &[5, 5, 5],
            item: 43,
            count: 4,
        }];
        assert!(matching_recipe(&[stack(5, 1); 4], 2, 2, &wide).is_none());
        assert!(matching_recipe(&[stack(5, 1); 3], 3, 1, &wide).is_some());
        let mixed = [world::recipes::Recipe {
            width: 0,
            height: 0,
            ingredients: &[5, 5, 8],
            item: 43,
            count: 4,
        }];
        assert!(matching_recipe(
            &[stack(8, 64), stack(5, 1), None, stack(5, 2)],
            2,
            2,
            &mixed
        )
        .is_some());
        assert!(
            matching_recipe(&[stack(8, 1), stack(8, 1), None, stack(5, 2)], 2, 2, &mixed).is_none()
        );
        let asymmetric = [world::recipes::Recipe {
            width: 2,
            height: 1,
            ingredients: &[5, 8],
            item: 43,
            count: 4,
        }];
        assert!(
            matching_recipe(&[stack(8, 1), stack(5, 1), None, None], 2, 2, &asymmetric).is_none()
        );
    }
    #[test]
    fn all_tool_recipes_match_every_offset_without_mirroring() {
        for material in ["wooden", "stone", "copper", "iron"] {
            for tool in ["pickaxe", "axe", "shovel"] {
                let item = items::by_name(&format!("{material}_{tool}")).unwrap();
                let recipe = world::recipes::RECIPES
                    .iter()
                    .find(|r| r.item == item)
                    .unwrap();
                assert_eq!(recipe.height, 3);
                assert_eq!(recipe.count, 1);
                for x in 0..=3 - recipe.width {
                    let mut grid = [None; 9];
                    for y in 0..3 {
                        for dx in 0..recipe.width {
                            let ingredient = recipe.ingredients[y * recipe.width + dx];
                            grid[y * 3 + x + dx] = (ingredient != 0).then_some(Stack {
                                item: ingredient,
                                count: 2,
                            });
                        }
                    }
                    assert_eq!(
                        matching_recipe(&grid, 3, 3, world::recipes::RECIPES)
                            .unwrap()
                            .item,
                        item
                    );
                    assert!(
                        matching_recipe(&grid[..4], 2, 2, std::slice::from_ref(recipe)).is_none()
                    );
                    if tool == "axe" {
                        for row in grid.chunks_mut(3) {
                            row.reverse();
                        }
                        assert!(matching_recipe(&grid, 3, 3, world::recipes::RECIPES).is_none());
                    }
                }
            }
        }
    }
    #[test]
    fn table_clicks_share_atomic_result_shift_and_return_order() {
        let mut inv = Inventory::default();
        for slot in 41..=51 {
            assert!(inv.click(slot, 0, false).is_err());
        }
        inv.screen = Screen::CraftingTable { pos: [1, 2, 3] };
        for slot in 36..=40 {
            assert!(inv.click(slot, 0, false).is_err());
        }
        assert!(inv.click(51, 0, false).is_err());
        inv.table[8] = stack(8, 3);
        let (restored, _) = Inventory::from_bytes(&inv.to_bytes(PlayerVitals::default())).unwrap();
        assert_eq!(restored.screen, Screen::None);
        assert_eq!(restored.table, inv.table);
        inv.slots = [stack(1, 64); 36];
        inv.slots[10] = stack(5, 59);
        inv.click(50, 0, true).unwrap();
        assert_eq!(inv.slots[10], stack(5, 63));
        assert_eq!(inv.table[8], stack(8, 2));
        inv.cursor = stack(5, 61);
        inv.click(50, 1, false).unwrap();
        assert_eq!(inv.table[8], stack(8, 2));
        inv.cursor = None;
        inv.click(50, 1, false).unwrap();
        assert_eq!(inv.cursor, stack(5, 4));
        assert_eq!(inv.table[8], stack(8, 1));
        inv.table[0] = stack(1, 3);
        inv.slots[0] = stack(1, 60);
        inv.click(41, 0, true).unwrap();
        assert_eq!(inv.slots[0], stack(1, 63));
        assert_eq!(inv.table[0], None);
        inv.slots.fill(stack(1, 64));
        inv.crafting[0] = stack(43, 1);
        assert_eq!(
            inv.return_crafting(),
            vec![
                Stack { item: 43, count: 1 },
                Stack { item: 8, count: 1 },
                Stack { item: 5, count: 4 }
            ]
        );
        assert_eq!(inv.screen, Screen::None);
        assert_eq!(inv.table, [None; 9]);
        assert_eq!(inv.crafting, [None; 4]);
        assert_eq!(inv.cursor, None);
    }
    #[test]
    fn normal_clicks_pick_place_merge_swap_split_and_single_place() {
        let mut inv = Inventory::default();
        inv.slots[0] = stack(5, 5);
        inv.click(0, 1, false).unwrap();
        assert_eq!(inv.cursor, stack(5, 3));
        assert_eq!(inv.slots[0], stack(5, 2));
        inv.click(1, 1, false).unwrap();
        assert_eq!(inv.cursor, stack(5, 2));
        assert_eq!(inv.slots[1], stack(5, 1));
        inv.slots[2] = stack(8, 7);
        inv.click(2, 1, false).unwrap();
        assert_eq!(inv.cursor, stack(8, 7));
        assert_eq!(inv.slots[2], stack(5, 2));
        inv.click(3, 0, false).unwrap();
        assert_eq!(inv.cursor, None);
        inv.click(3, 0, false).unwrap();
        assert_eq!(inv.cursor, stack(8, 7));
        assert_eq!(inv.slots[3], None);
        inv.slots[4] = stack(8, 62);
        inv.click(4, 0, false).unwrap();
        assert_eq!(inv.slots[4], stack(8, 64));
        assert_eq!(inv.cursor, stack(8, 5));
        inv.click(4, 1, false).unwrap();
        assert_eq!(inv.cursor, stack(8, 5));
        inv.click(2, 0, false).unwrap();
        assert_eq!(inv.cursor, stack(5, 2));
        assert_eq!(inv.slots[2], stack(8, 5));
        assert!(inv.click(41, 0, false).is_err());
        assert!(inv.click(0, 2, false).is_err());
    }
    #[test]
    fn result_is_atomic_and_shift_stops_before_overflow() {
        let mut inv = Inventory::default();
        inv.crafting[3] = stack(8, 3);
        inv.cursor = stack(1, 1);
        inv.click(40, 0, false).unwrap();
        assert_eq!(inv.crafting[3], stack(8, 3));
        inv.cursor = stack(5, 61);
        inv.click(40, 1, false).unwrap();
        assert_eq!(inv.crafting[3], stack(8, 3));
        inv.cursor = stack(5, 60);
        inv.click(40, 1, false).unwrap();
        assert_eq!(inv.cursor, stack(5, 64));
        assert_eq!(inv.crafting[3], stack(8, 2));
        inv.slots = [stack(1, 64); 36];
        inv.slots[10] = stack(5, 59);
        inv.click(40, 0, true).unwrap();
        assert_eq!(inv.slots[10], stack(5, 63));
        assert_eq!(inv.crafting[3], stack(8, 1));
        inv.cursor = None;
        inv.click(40, 0, false).unwrap();
        assert_eq!(inv.cursor, stack(5, 4));
        assert_eq!(inv.result(), None);
        inv.click(40, 0, false).unwrap();
        assert_eq!(inv.cursor, stack(5, 4));
    }
    #[test]
    fn shift_moves_between_regions_merging_before_empty_slots() {
        let mut inv = Inventory::default();
        inv.slots[0] = stack(5, 8);
        inv.slots[20] = stack(5, 62);
        inv.click(0, 0, true).unwrap();
        assert_eq!(inv.slots[20], stack(5, 64));
        assert_eq!(inv.slots[9], stack(5, 6));
        assert_eq!(inv.slots[0], None);
        inv.click(9, 1, true).unwrap();
        assert_eq!(inv.slots[0], stack(5, 6));
        inv.crafting[0] = stack(5, 8);
        inv.click(36, 0, true).unwrap();
        assert_eq!(inv.slots[0], stack(5, 14));
        assert_eq!(inv.crafting[0], None);
        inv.slots[9..].fill(stack(1, 64));
        inv.slots[12] = stack(5, 63);
        inv.click(0, 0, true).unwrap();
        assert_eq!(inv.slots[0], stack(5, 13));
        assert_eq!(inv.slots[12], stack(5, 64));
        inv.crafting[1] = stack(8, 3);
        inv.click(37, 0, true).unwrap();
        assert_eq!(inv.slots[1], stack(8, 3));
    }
    #[test]
    fn log_to_planks_stick_and_table_using_only_clicks() {
        let mut inv = Inventory::default();
        inv.slots[0] = stack(8, 2);
        for (slot, button, shift) in [
            (0, 0, false),
            (36, 0, false),
            (40, 0, true),
            (0, 0, false),
            (36, 1, false),
            (38, 1, false),
            (1, 0, false),
            (40, 0, false),
            (2, 0, false),
            (1, 0, false),
            (36, 1, false),
            (37, 1, false),
            (38, 1, false),
            (39, 1, false),
            (1, 0, false),
            (40, 0, false),
            (3, 0, false),
        ] {
            inv.click(slot, button, shift).unwrap();
        }
        assert_eq!(inv.slots[2], stack(43, 4));
        assert_eq!(inv.slots[3], stack(44, 1));
        assert_eq!(inv.slots[1], stack(5, 2));
        assert_eq!(inv.cursor, None);
        assert_eq!(inv.crafting, [None; 4]);
    }
}

#[cfg(test)]
mod furnace_click_tests {
    use super::*;
    fn stack(name: &str, count: u8) -> Option<Stack> {
        Some(Stack {
            item: items::by_name(name).unwrap(),
            count,
        })
    }
    #[test]
    fn furnace_pick_place_split_shift_and_output_are_conservative() {
        let mut inv = Inventory {
            screen: Screen::Furnace { pos: [0, 0, 0] },
            ..Inventory::default()
        };
        let mut f = crate::furnace::Furnace::default();
        inv.cursor = stack("dirt", 5);
        inv.click_furnace(&mut f, 51, 1, false).unwrap();
        assert_eq!(f.slots[0], stack("dirt", 1));
        inv.click_furnace(&mut f, 51, 0, false).unwrap();
        assert_eq!(f.slots[0], stack("dirt", 5));
        inv.click_furnace(&mut f, 51, 1, false).unwrap();
        assert_eq!(inv.cursor, stack("dirt", 3));
        inv.click_furnace(&mut f, 52, 0, false).unwrap();
        assert_eq!(f.slots[1], None);
        inv.cursor = stack("coal", 3);
        inv.click_furnace(&mut f, 52, 0, false).unwrap();
        assert_eq!(f.slots[1], stack("coal", 3));
        assert_eq!(inv.cursor, None);
        inv.click_furnace(&mut f, 52, 0, true).unwrap();
        assert_eq!(inv.slots[0], stack("coal", 3));
        f.slots[2] = stack("iron_ingot", 8);
        inv.cursor = stack("dirt", 1);
        inv.click_furnace(&mut f, 53, 0, false).unwrap();
        assert_eq!(f.slots[2], stack("iron_ingot", 8));
        inv.cursor = stack("iron_ingot", 63);
        inv.click_furnace(&mut f, 53, 0, false).unwrap();
        assert_eq!(inv.cursor, stack("iron_ingot", 64));
        assert_eq!(f.slots[2], stack("iron_ingot", 7));
        inv.cursor = None;
        inv.click_furnace(&mut f, 53, 1, false).unwrap();
        assert_eq!(inv.cursor, stack("iron_ingot", 4));
        inv.slots.fill(stack("dirt", 64));
        inv.slots[10] = stack("iron_ingot", 63);
        inv.click_furnace(&mut f, 53, 0, true).unwrap();
        assert_eq!(f.slots[2], stack("iron_ingot", 2));
        assert_eq!(inv.slots[10], stack("iron_ingot", 64));
        inv.cursor = stack("coal", 1);
        f.slots[2] = None;
        inv.click_furnace(&mut f, 53, 0, false).unwrap();
        assert_eq!(f.slots[2], None);
        assert_eq!(inv.cursor, stack("coal", 1));
    }
}
