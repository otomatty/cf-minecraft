//! Deterministic player inventory. Slot order is also insertion order.
use protocol::{PlayerVitals, CHEST_SLOT_COUNT, CHEST_SLOT_START};
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
    pub damage: u16,
}
impl Stack {
    fn matches_item_and_damage(self, item: u16, damage: u16) -> bool {
        self.item == item && self.damage == damage
    }

    pub(crate) fn wire(self) -> protocol::ItemStack {
        (self.item, self.count, self.damage)
    }

    pub(crate) fn write_slot(slot: Option<Self>, w: &mut Writer, with_damage: bool) {
        let (item, count, damage) = slot.map_or((0, 0, 0), Self::wire);
        w.u16(item);
        w.u8(count);
        if with_damage {
            w.u16(damage);
        }
    }

    pub(crate) fn read_slot(
        r: &mut Reader<'_>,
        with_damage: bool,
    ) -> Result<Option<Self>, DecodeError> {
        let item = r.u16()?;
        let count = r.u8()?;
        let damage = if with_damage { r.u16()? } else { 0 };
        if item == 0 && count == 0 {
            return Ok(None);
        }
        let stack = Self {
            item,
            count,
            damage: normalize_damage(item, damage),
        };
        if !valid(stack) {
            return Err(DecodeError);
        }
        Ok(Some(stack))
    }
}

pub(crate) fn normalize_damage(item: u16, damage: u16) -> u16 {
    items::info(item)
        .and_then(|i| i.durability)
        .map_or(0, |max| damage.min(max - 1))
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
    Chest {
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
                damage: 0,
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
        self.take_selected_stack().map(|stack| stack.item)
    }

    pub(crate) fn take_selected_stack(&mut self) -> Option<Stack> {
        let slot = &mut self.slots[self.selected as usize];
        let stack = (*slot)?;
        subtract(slot, 1);
        Some(Stack { count: 1, ..stack })
    }

    /// Returns whether the selected item broke, if it had durability.
    pub(crate) fn wear_selected(&mut self) -> Option<bool> {
        let slot = &mut self.slots[self.selected as usize];
        let stack = slot.as_mut()?;
        let max = items::info(stack.item)?.durability?;
        stack.damage += 1;
        let broken = stack.damage == max;
        if broken {
            *slot = None;
        }
        Some(broken)
    }

    pub(crate) fn first_slot_with(&self, item: u16) -> Option<usize> {
        self.slots
            .iter()
            .position(|slot| slot.is_some_and(|stack| stack.item == item))
    }

    pub(crate) fn take_one(&mut self, slot: usize) {
        subtract(&mut self.slots[slot], 1);
    }

    pub fn add(&mut self, item: u16, count: u32) -> u32 {
        add_slots(&mut self.slots, item, count, 0)
    }

    pub(crate) fn add_stack(&mut self, stack: Stack) -> u8 {
        add_slots(
            &mut self.slots,
            stack.item,
            u32::from(stack.count),
            stack.damage,
        ) as u8
    }

    pub fn result(&self) -> Option<Stack> {
        if matches!(self.screen, Screen::Furnace { .. } | Screen::Chest { .. }) {
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
            damage: 0,
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
        if matches!(self.screen, Screen::Furnace { .. } | Screen::Chest { .. }) {
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
                    if next.add_stack(result) != 0 {
                        break;
                    }
                    self.slots = next.slots;
                } else {
                    if self.cursor.is_some_and(|s| {
                        !s.matches_item_and_damage(result.item, result.damage)
                            || u16::from(s.count) + u16::from(result.count)
                                > u16::from(items::info(s.item).unwrap().max_stack)
                    }) {
                        break;
                    }
                    self.cursor = Some(Stack {
                        count: self.cursor.map_or(0, |s| s.count) + result.count,
                        ..result
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
                let remaining = add_slots(
                    &mut self.slots[range],
                    stack.item,
                    u32::from(stack.count),
                    stack.damage,
                );
                let source = if index < 36 {
                    &mut self.slots[index]
                } else if base == 36 {
                    &mut self.crafting[index - 36]
                } else {
                    &mut self.table[index - 41]
                };
                *source = (remaining != 0).then_some(Stack {
                    count: remaining as u8,
                    ..stack
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
            Self::click_stack(&mut self.cursor, target, button);
        }
        Ok(())
    }

    fn click_stack(cursor: &mut Option<Stack>, target: &mut Option<Stack>, button: u8) {
        match (*cursor, *target) {
            (None, Some(s)) => {
                let count = if button == 0 {
                    s.count
                } else {
                    s.count.div_ceil(2)
                };
                *cursor = Some(Stack { count, ..s });
                subtract(target, count);
            }
            (Some(c), t) if t.is_none_or(|s| s.matches_item_and_damage(c.item, c.damage)) => {
                let present = t.map_or(0, |s| s.count);
                let count = (items::info(c.item).unwrap().max_stack - present)
                    .min(if button == 0 { c.count } else { 1 });
                if count > 0 {
                    *target = Some(Stack {
                        count: present + count,
                        ..c
                    });
                    subtract(cursor, count);
                }
            }
            (Some(_), Some(_)) => std::mem::swap(target, cursor),
            _ => {}
        }
    }

    pub fn click_chest(
        &mut self,
        chest: &mut [Option<Stack>; CHEST_SLOT_COUNT],
        slot: u8,
        button: u8,
        shift: bool,
    ) -> Result<(), DecodeError> {
        if button > 1 {
            return Err(DecodeError);
        }
        let (source, destination) = if usize::from(slot) < SLOT_COUNT {
            (&mut self.slots[usize::from(slot)], &mut chest[..])
        } else {
            let index = slot.checked_sub(CHEST_SLOT_START).ok_or(DecodeError)?;
            (
                chest.get_mut(usize::from(index)).ok_or(DecodeError)?,
                &mut self.slots[..],
            )
        };
        if shift {
            if let Some(stack) = *source {
                let remaining = add_slots(
                    destination,
                    stack.item,
                    u32::from(stack.count),
                    stack.damage,
                );
                subtract(source, stack.count - remaining as u8);
            }
        } else {
            Self::click_stack(&mut self.cursor, source, button);
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
                        let left =
                            add_slots(&mut f.slots[i..=i], s.item, u32::from(s.count), s.damage);
                        subtract(&mut self.slots[slot as usize], s.count - left as u8);
                        return Ok(());
                    }
                }
            } else {
                let source = &mut f.slots[(slot - 51) as usize];
                if let Some(s) = *source {
                    let left = self.add_stack(s);
                    subtract(source, s.count - left);
                }
                return Ok(());
            }
        }
        if slot == 53 {
            if let Some(s) = f.slots[2] {
                if self
                    .cursor
                    .is_none_or(|c| c.matches_item_and_damage(s.item, s.damage))
                {
                    let room =
                        items::info(s.item).unwrap().max_stack - self.cursor.map_or(0, |c| c.count);
                    let count = room.min(if button == 0 {
                        s.count
                    } else {
                        s.count.div_ceil(2)
                    });
                    if count > 0 {
                        self.cursor = Some(Stack {
                            count: self.cursor.map_or(0, |c| c.count) + count,
                            ..s
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
            let count = self.add_stack(stack);
            if count > 0 {
                overflow.push(Stack { count, ..stack });
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

    pub fn to_bytes(&self, vitals: PlayerVitals, respawn: Option<[i32; 3]>) -> Vec<u8> {
        let mut w = Writer::new();
        w.u8(7);
        w.u8(self.selected);
        for slot in self
            .slots
            .into_iter()
            .chain(self.crafting)
            .chain([self.cursor])
            .chain(self.table)
        {
            Stack::write_slot(slot, &mut w, true);
        }
        vitals.write(&mut w);
        match respawn {
            None => w.u8(0),
            Some([x, y, z]) => {
                w.u8(1);
                w.i32(x);
                w.i32(y);
                w.i32(z);
            }
        }
        w.finish()
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<(Self, PlayerVitals, Option<[i32; 3]>), DecodeError> {
        let mut r = Reader::new(bytes);
        let version = r.u8()?;
        if !matches!(version, 1..=7) {
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
            *slot = Stack::read_slot(&mut r, version >= 6)?;
        }
        let vitals = match version {
            5..=7 => PlayerVitals::read(&mut r)?,
            4 => PlayerVitals::read_v4(&mut r)?,
            _ => PlayerVitals::default(),
        };
        let respawn = if version >= 7 {
            match r.u8()? {
                0 => None,
                1 => Some([r.i32()?, r.i32()?, r.i32()?]),
                _ => return Err(DecodeError),
            }
        } else {
            None
        };
        if r.remaining() != 0 {
            return Err(DecodeError);
        }
        Ok((result, vitals, respawn))
    }
}
pub(crate) fn valid(s: Stack) -> bool {
    items::info(s.item).is_some_and(|i| {
        (1..=i.max_stack).contains(&s.count)
            && i.durability.map_or(s.damage == 0, |max| s.damage < max)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn insertion_merges_before_filling_empty_slots_and_returns_overflow() {
        let mut inv = Inventory::default();
        inv.set(
            12,
            Some(Stack {
                item: 1,
                count: 60,
                damage: 0,
            }),
        )
        .unwrap();
        assert_eq!(inv.add(1, 70), 0);
        assert_eq!(inv.slots[12].unwrap().count, 64);
        assert_eq!(inv.slots[0].unwrap().count, 64);
        assert_eq!(inv.slots[1].unwrap().count, 2);
        assert_eq!(inv.add(1, 64 * 36), 130);
        assert_eq!(inv.add(u16::MAX, 3), 3);
    }
    fn v5_save(inv: &Inventory, vitals: PlayerVitals) -> Vec<u8> {
        let mut w = Writer::new();
        w.u8(5);
        w.u8(inv.selected);
        for slot in inv
            .slots
            .into_iter()
            .chain(inv.crafting)
            .chain([inv.cursor])
            .chain(inv.table)
        {
            Stack::write_slot(slot, &mut w, false);
        }
        vitals.write(&mut w);
        w.finish()
    }

    #[test]
    fn persistence_preserves_transient_slots_and_reads_v1_through_v4() {
        let mut inv = Inventory::creative();
        inv.select(7).unwrap();
        inv.crafting = [
            Some(Stack {
                item: 8,
                count: 64,
                damage: 0,
            }),
            None,
            Some(Stack {
                item: 5,
                count: 3,
                damage: 0,
            }),
            Some(Stack {
                item: 31,
                count: 1,
                damage: 0,
            }),
        ];
        inv.cursor = Some(Stack {
            item: 43,
            count: 5,
            damage: 0,
        });
        inv.table[8] = Some(Stack {
            item: 5,
            count: 7,
            damage: 0,
        });
        let vitals = PlayerVitals::default();
        let bytes = inv.to_bytes(vitals, None);
        assert_eq!(bytes.len(), 259);
        assert_eq!(bytes[0], 7);
        assert_eq!(
            Inventory::from_bytes(&bytes),
            Ok((inv.clone(), vitals, None))
        );
        let v5 = v5_save(&inv, vitals);
        assert_eq!(Inventory::from_bytes(&v5), Ok((inv.clone(), vitals, None)));
        let mut v4 = v5[..157].to_vec();
        v4[0] = 4;
        assert_eq!(Inventory::from_bytes(&v4), Ok((inv.clone(), vitals, None)));
        let mut v3 = v5[..152].to_vec();
        v3[0] = 3;
        assert_eq!(Inventory::from_bytes(&v3), Ok((inv.clone(), vitals, None)));
        let mut v2 = v5[..125].to_vec();
        v2[0] = 2;
        let mut expected_v2 = inv.clone();
        expected_v2.table = [None; 9];
        assert_eq!(Inventory::from_bytes(&v2), Ok((expected_v2, vitals, None)));
        let mut legacy = v5[..110].to_vec();
        legacy[0] = 1;
        let mut expected = inv.clone();
        expected.crafting = [None; 4];
        expected.cursor = None;
        expected.table = [None; 9];
        assert_eq!(Inventory::from_bytes(&legacy), Ok((expected, vitals, None)));
        for data in [&bytes, &v5, &v4, &v3, &v2, &legacy] {
            for length in 0..data.len() {
                assert!(Inventory::from_bytes(&data[..length]).is_err());
            }
            let mut extra = data.clone();
            extra.push(0);
            assert!(Inventory::from_bytes(&extra).is_err());
        }
        for offset in [182, 187, 192, 197, 202, 207, 247] {
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
    fn persistence_v5_and_v6_store_vitals_and_rejects_invalid_status() {
        use protocol::DeathCause;

        let inv = Inventory::default();
        let vitals = PlayerVitals {
            health: 0,
            air: 42,
            dead: true,
            cause: DeathCause::Void,
            food: 9,
        };
        let save = inv.to_bytes(vitals, None);
        assert_eq!(&save[252..258], &[0, 0, 42, 1, 4, 9]);
        assert_eq!(save[258], 0);
        assert_eq!(
            Inventory::from_bytes(&save),
            Ok((inv.clone(), vitals, None))
        );
        let explosion = PlayerVitals {
            cause: DeathCause::Explosion,
            ..vitals
        };
        let explosion_save = inv.to_bytes(explosion, None);
        assert_eq!(explosion_save[256], 8);
        assert_eq!(
            Inventory::from_bytes(&explosion_save),
            Ok((inv.clone(), explosion, None))
        );
        let v5 = v5_save(&inv, vitals);
        assert_eq!(Inventory::from_bytes(&v5), Ok((inv.clone(), vitals, None)));
        let mut v4 = v5[..157].to_vec();
        v4[0] = 4;
        assert_eq!(
            Inventory::from_bytes(&v4),
            Ok((inv, PlayerVitals { food: 20, ..vitals }, None))
        );
        for (offset, value) in [
            (152, 1),
            (152, 21),
            (153, 2),
            (155, 0),
            (155, 2),
            (156, 0),
            (156, 10),
            (157, 21),
        ] {
            for (data, offset) in [(&v5, offset), (&save, offset + 100)] {
                let mut bad = data.clone();
                bad[offset] = value;
                assert!(Inventory::from_bytes(&bad).is_err(), "{offset} = {value}");
            }
        }
    }
    #[test]
    fn persistence_keeps_wear_and_normalizes_invalid_damage() {
        let item = items::by_name("wooden_pickaxe").unwrap();
        let tool = Stack {
            item,
            count: 1,
            damage: 31,
        };
        let mut inv = Inventory::creative();
        inv.set(0, Some(tool)).unwrap();
        inv.crafting[3] = Some(tool);
        inv.cursor = Some(tool);
        inv.table[8] = Some(tool);

        let vitals = PlayerVitals::default();
        let bytes = inv.to_bytes(vitals, None);
        assert_eq!(
            Inventory::from_bytes(&bytes),
            Ok((inv.clone(), vitals, None))
        );
        let v5 = v5_save(&inv, vitals);
        assert_eq!(v5.len(), 158);
        assert_eq!(&v5[2..4], &item.to_be_bytes());
        assert_eq!(v5[4], 1);
        let (legacy, _, _) = Inventory::from_bytes(&v5).unwrap();
        assert_eq!(legacy.slots[0], Some(Stack { damage: 0, ..tool }));
        assert_eq!(legacy.crafting[3].unwrap().damage, 0);
        assert_eq!(legacy.cursor.unwrap().damage, 0);
        assert_eq!(legacy.table[8].unwrap().damage, 0);

        let mut corrupt = bytes;
        corrupt[5..7].copy_from_slice(&u16::MAX.to_be_bytes());
        corrupt[10..12].copy_from_slice(&1u16.to_be_bytes());
        let (restored, _, _) = Inventory::from_bytes(&corrupt).unwrap();
        let max = items::info(item).unwrap().durability.unwrap();
        assert_eq!(
            restored.slots[0],
            Some(Stack {
                damage: max - 1,
                ..tool
            })
        );
        assert_eq!(restored.slots[1], inv.slots[1]);
    }

    #[test]
    fn moving_a_worn_tool_preserves_damage_in_each_screen_and_on_return() {
        let tool = Stack {
            item: items::by_name("bow").unwrap(),
            count: 1,
            damage: 34,
        };
        let mut inv = Inventory::default();
        inv.set(0, Some(tool)).unwrap();
        for (screen, slot) in [
            (Screen::None, 36),
            (Screen::CraftingTable { pos: [0; 3] }, 41),
        ] {
            inv.screen = screen;
            inv.click(0, 1, false).unwrap();
            assert_eq!(inv.cursor, Some(tool));
            inv.click(slot, 1, false).unwrap();
            assert_eq!(inv.grid()[0], Some(tool));
            inv.click(slot, 0, true).unwrap();
            assert_eq!(inv.slots[0], Some(tool));
        }

        let mut f = crate::furnace::Furnace::default();
        inv.screen = Screen::Furnace { pos: [0; 3] };
        inv.click_furnace(&mut f, 0, 0, false).unwrap();
        inv.click_furnace(&mut f, 51, 0, false).unwrap();
        assert_eq!(f.slots[0], Some(tool));
        inv.click_furnace(&mut f, 51, 0, true).unwrap();
        assert_eq!(inv.slots[0], Some(tool));

        inv.screen = Screen::None;
        inv.click(0, 0, false).unwrap();
        inv.click(36, 0, false).unwrap();
        assert!(inv.return_crafting().is_empty());
        assert_eq!(inv.slots[0], Some(tool));
        inv.click(0, 0, true).unwrap();
        assert_eq!(inv.slots[9], Some(tool));
        inv.click(9, 0, false).unwrap();
        inv.slots.fill(Some(Stack {
            item: 1,
            count: 64,
            damage: 0,
        }));
        assert_eq!(inv.return_crafting(), vec![tool]);
    }

    #[test]
    fn clicks_swap_pickaxes_with_different_wear_in_inventory_and_screens() {
        let item = items::by_name("wooden_pickaxe").unwrap();
        let fresh = Stack {
            item,
            count: 1,
            damage: 0,
        };
        let worn = Stack {
            damage: items::info(item).unwrap().durability.unwrap() - 1,
            ..fresh
        };
        let furnace = Screen::Furnace { pos: [0; 3] };
        for (screen, slot) in [
            (Screen::None, 1),
            (Screen::None, 36),
            (Screen::CraftingTable { pos: [0; 3] }, 41),
            (furnace, 1),
            (furnace, 51),
        ] {
            let mut inv = Inventory::default();
            inv.set(0, Some(worn)).unwrap();
            inv.set(1, Some(fresh)).unwrap();
            inv.screen = screen;
            let mut f = crate::furnace::Furnace::default();
            let mut click = |inv: &mut Inventory, slot| {
                if screen == furnace {
                    inv.click_furnace(&mut f, slot, 0, false).unwrap();
                } else {
                    inv.click(slot, 0, false).unwrap();
                }
            };
            if slot != 1 {
                click(&mut inv, 1);
                click(&mut inv, slot);
            }
            click(&mut inv, 0);
            assert_eq!(inv.cursor, Some(worn));
            click(&mut inv, slot);
            assert_eq!(inv.cursor, Some(fresh), "{screen:?}, slot {slot}");
            click(&mut inv, 0);
            click(&mut inv, slot);
            assert_eq!(inv.cursor, Some(worn), "{screen:?}, slot {slot}");
            assert_eq!(inv.slots[0], Some(fresh));
        }
    }

    #[test]
    fn clicking_matching_stacks_respects_the_stack_limit() {
        let mut inv = Inventory::default();
        let pickaxe = Stack {
            item: items::by_name("wooden_pickaxe").unwrap(),
            count: 1,
            damage: 1,
        };
        inv.set(0, Some(pickaxe)).unwrap();
        inv.cursor = Some(pickaxe);
        let before = inv.clone();
        inv.click(0, 0, false).unwrap();
        assert_eq!(inv, before);

        let stone = Stack {
            item: items::by_name("stone").unwrap(),
            count: 2,
            damage: 0,
        };
        inv.set(0, Some(stone)).unwrap();
        inv.cursor = Some(stone);
        inv.click(0, 0, false).unwrap();
        assert_eq!(inv.slots[0], Some(Stack { count: 4, ..stone }));
        assert_eq!(inv.cursor, None);
    }

    #[test]
    fn persistence_is_strict_and_round_trips() {
        let mut inv = Inventory::creative();
        inv.select(8).unwrap();
        let vitals = PlayerVitals::default();
        let bytes = inv.to_bytes(vitals, None);
        assert_eq!(Inventory::from_bytes(&bytes), Ok((inv, vitals, None)));
        for (at, value) in [(0, 8), (1, 9), (2, 255), (4, 0), (4, 65), (3, 0)] {
            let mut bad = bytes.clone();
            bad[at] = value;
            assert!(Inventory::from_bytes(&bad).is_err(), "{at} {value}");
        }
        assert!(Inventory::from_bytes(&bytes[..bytes.len() - 1]).is_err());
        let mut bad = bytes;
        bad.push(0);
        assert!(Inventory::from_bytes(&bad).is_err());
    }

    #[test]
    fn persistence_v7_stores_respawn_and_v6_has_none() {
        let inv = Inventory::default();
        let vitals = PlayerVitals::default();
        let none = inv.to_bytes(vitals, None);
        assert_eq!((none.len(), none[0], none[258]), (259, 7, 0));
        assert_eq!(
            Inventory::from_bytes(&none),
            Ok((inv.clone(), vitals, None))
        );
        let point = [-3, -64, 12];
        let some = inv.to_bytes(vitals, Some(point));
        assert_eq!(some.len(), 271);
        assert_eq!(some[258], 1);
        assert_eq!(
            Inventory::from_bytes(&some),
            Ok((inv.clone(), vitals, Some(point)))
        );
        let mut v6 = none;
        v6[0] = 6;
        v6.pop();
        assert_eq!(v6.len(), 258);
        assert_eq!(Inventory::from_bytes(&v6), Ok((inv, vitals, None)));
        assert!(Inventory::from_bytes(&some[..270]).is_err());
        let mut bad = some;
        bad[258] = 2;
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
fn add_slots(slots: &mut [Option<Stack>], item: u16, mut count: u32, damage: u16) -> u32 {
    let Some(info) = items::info(item) else {
        return count;
    };
    for slot in slots
        .iter_mut()
        .flatten()
        .filter(|s| s.matches_item_and_damage(item, damage))
    {
        let n = count.min(u32::from(info.max_stack - slot.count)) as u8;
        slot.count += n;
        count -= u32::from(n);
    }
    for slot in slots.iter_mut().filter(|s| s.is_none()) {
        if count == 0 {
            break;
        }
        let n = count.min(u32::from(info.max_stack)) as u8;
        *slot = Some(Stack {
            item,
            count: n,
            damage,
        });
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
        if r.table_only && (width < 3 || height < 3) {
            return false;
        }
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
        Some(Stack {
            item,
            count,
            damage: 0,
        })
    }
    #[test]
    fn chest_recipe_consumes_eight_planks_and_only_fits_the_table() {
        let plank = stack(items::by_name("oak_planks").unwrap(), 1);
        let chest = stack(items::by_name("chest").unwrap(), 1);
        let mut inv = Inventory {
            crafting: [stack(plank.unwrap().item, 2); 4],
            table: [plank; 9],
            ..Inventory::default()
        };
        inv.table[4] = None;
        assert_ne!(inv.result(), chest);
        inv.screen = Screen::CraftingTable { pos: [0; 3] };
        assert_eq!(inv.result(), chest);
        inv.click(50, 0, false).unwrap();
        assert_eq!(inv.cursor, chest);
        assert_eq!(inv.table, [None; 9]);
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
            table_only: false,
            width: 3,
            height: 1,
            ingredients: &[5, 5, 5],
            item: 43,
            count: 4,
        }];
        assert!(matching_recipe(&[stack(5, 1); 4], 2, 2, &wide).is_none());
        assert!(matching_recipe(&[stack(5, 1); 3], 3, 1, &wide).is_some());
        let mixed = [world::recipes::Recipe {
            table_only: false,
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
            table_only: false,
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
                                damage: 0,
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
    fn coal_above_a_stick_crafts_four_torches_in_the_personal_grid() {
        let coal = stack(items::by_name("coal").unwrap(), 2);
        let stick = stack(items::by_name("stick").unwrap(), 1);
        let mut inv = Inventory {
            crafting: [None, stick, None, coal],
            ..Inventory::default()
        };
        assert_eq!(inv.result(), None);
        inv.crafting.swap(1, 3);
        inv.click(40, 0, false).unwrap();
        assert_eq!(inv.cursor, stack(items::by_name("torch").unwrap(), 4));
        assert_eq!(
            inv.crafting,
            [None, stack(items::by_name("coal").unwrap(), 1), None, None]
        );
    }

    #[test]
    fn table_crafts_bow_and_arrows_from_their_ingredients() {
        let stick = stack(items::by_name("stick").unwrap(), 1);
        let thread = stack(items::by_name("string").unwrap(), 1);
        let feather = stack(items::by_name("feather").unwrap(), 1);
        for (table, result, count) in [
            (
                [
                    None, stick, thread, stick, None, thread, None, stick, thread,
                ],
                "bow",
                1,
            ),
            (
                [None, None, None, None, stick, None, None, feather, None],
                "arrow",
                2,
            ),
        ] {
            let mut inv = Inventory {
                screen: Screen::CraftingTable { pos: [0; 3] },
                table,
                ..Inventory::default()
            };
            inv.click(50, 0, false).unwrap();
            assert_eq!(inv.cursor, stack(items::by_name(result).unwrap(), count));
            assert_eq!(inv.table, [None; 9]);
        }
        let wool = stack(items::by_name("white_wool").unwrap(), 1);
        let old_bow = Inventory {
            screen: Screen::CraftingTable { pos: [0; 3] },
            table: [None, stick, wool, stick, None, wool, None, stick, wool],
            ..Inventory::default()
        };
        assert_eq!(old_bow.result(), None);
        let inv = Inventory {
            crafting: [stick, None, feather, None],
            ..Inventory::default()
        };
        assert_eq!(inv.result(), None);
    }

    #[test]
    fn four_string_craft_white_wool_in_both_grids() {
        let thread = stack(items::by_name("string").unwrap(), 1);
        let wool = stack(items::by_name("white_wool").unwrap(), 1);
        let mut inv = Inventory {
            crafting: [thread; 4],
            ..Inventory::default()
        };
        inv.click(40, 0, false).unwrap();
        assert_eq!(inv.cursor, wool);
        assert_eq!(inv.crafting, [None; 4]);

        let mut inv = Inventory {
            screen: Screen::CraftingTable { pos: [0; 3] },
            table: [thread, thread, None, thread, thread, None, None, None, None],
            ..Inventory::default()
        };
        inv.click(50, 0, false).unwrap();
        assert_eq!(inv.cursor, wool);
        assert_eq!(inv.table, [None; 9]);
    }

    #[test]
    fn table_crafts_hoes_and_bread_from_their_ingredients() {
        let stick = stack(items::by_name("stick").unwrap(), 1);
        for (material, hoe) in [
            ("oak_planks", "wooden_hoe"),
            ("cobblestone", "stone_hoe"),
            ("copper_ingot", "copper_hoe"),
            ("iron_ingot", "iron_hoe"),
        ] {
            let head = stack(items::by_name(material).unwrap(), 1);
            let mut inv = Inventory {
                screen: Screen::CraftingTable { pos: [0; 3] },
                table: [head, head, None, None, stick, None, None, stick, None],
                ..Inventory::default()
            };
            inv.click(50, 0, false).unwrap();
            assert_eq!(inv.cursor, stack(items::by_name(hoe).unwrap(), 1));
            assert_eq!(inv.table, [None; 9]);
        }
        let mut inv = Inventory {
            screen: Screen::CraftingTable { pos: [0; 3] },
            ..Inventory::default()
        };
        inv.table[0..3].fill(stack(items::by_name("wheat").unwrap(), 1));
        inv.click(50, 0, false).unwrap();
        assert_eq!(inv.cursor, stack(items::by_name("bread").unwrap(), 1));
        assert_eq!(inv.table, [None; 9]);
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
        let (restored, _, _) =
            Inventory::from_bytes(&inv.to_bytes(PlayerVitals::default(), None)).unwrap();
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
                Stack {
                    item: 43,
                    count: 1,
                    damage: 0
                },
                Stack {
                    item: 8,
                    count: 1,
                    damage: 0
                },
                Stack {
                    item: 5,
                    count: 4,
                    damage: 0
                }
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
            damage: 0,
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

#[cfg(test)]
mod chest_click_tests {
    use super::*;

    fn stack(name: &str, count: u8) -> Option<Stack> {
        Some(Stack {
            item: items::by_name(name).unwrap(),
            count,
            damage: 0,
        })
    }

    #[test]
    fn chest_clicks_pick_place_split_and_swap() {
        let mut inv = Inventory {
            screen: Screen::Chest { pos: [0; 3] },
            ..Inventory::default()
        };
        let mut chest = [None; CHEST_SLOT_COUNT];
        chest[0] = stack("stone", 5);
        inv.click_chest(&mut chest, 54, 1, false).unwrap();
        assert_eq!(inv.cursor, stack("stone", 3));
        assert_eq!(chest[0], stack("stone", 2));
        inv.click_chest(&mut chest, 80, 1, false).unwrap();
        assert_eq!(chest[26], stack("stone", 1));
        assert_eq!(inv.cursor, stack("stone", 2));
        inv.click_chest(&mut chest, 0, 0, false).unwrap();
        assert_eq!(inv.slots[0], stack("stone", 2));
        assert_eq!(inv.cursor, None);
        inv.click_chest(&mut chest, 80, 0, false).unwrap();
        assert_eq!(chest[26], None);
        assert_eq!(inv.cursor, stack("stone", 1));
        chest[26] = stack("dirt", 5);
        inv.click_chest(&mut chest, 80, 0, false).unwrap();
        assert_eq!(chest[26], stack("stone", 1));
        assert_eq!(inv.cursor, stack("dirt", 5));
        inv.click_chest(&mut chest, 79, 0, false).unwrap();
        assert_eq!(chest[25], stack("dirt", 5));
        assert_eq!(inv.cursor, None);
    }

    #[test]
    fn chest_shift_merges_before_empty_slots_and_leaves_overflow_at_source() {
        let mut inv = Inventory {
            screen: Screen::Chest { pos: [0; 3] },
            slots: [stack("dirt", 64); SLOT_COUNT],
            ..Inventory::default()
        };
        let mut chest = [stack("dirt", 64); CHEST_SLOT_COUNT];
        inv.slots[0] = stack("stone", 5);
        inv.slots[9] = None;
        inv.slots[35] = stack("stone", 63);
        chest[0] = None;
        chest[1] = None;
        chest[26] = stack("stone", 62);
        inv.click_chest(&mut chest, 0, 0, true).unwrap();
        assert_eq!(chest[26], stack("stone", 64));
        assert_eq!(chest[0], stack("stone", 3));
        assert_eq!(chest[1], None);
        assert_eq!(inv.slots[0], None);

        inv.slots[0] = stack("dirt", 64);
        inv.click_chest(&mut chest, 54, 0, true).unwrap();
        assert_eq!(inv.slots[35], stack("stone", 64));
        assert_eq!(inv.slots[9], stack("stone", 2));
        assert_eq!(chest[0], None);

        inv.click_chest(&mut chest, 80, 0, true).unwrap();
        assert_eq!(inv.slots[9], stack("stone", 64));
        assert_eq!(chest[26], stack("stone", 2));
        chest[0] = stack("dirt", 64);
        chest[1] = stack("dirt", 64);
        chest[26] = stack("stone", 63);
        inv.click_chest(&mut chest, 9, 0, true).unwrap();
        assert_eq!(chest[26], stack("stone", 64));
        assert_eq!(inv.slots[9], stack("stone", 63));
    }
}
