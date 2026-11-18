//! Loaded, shared furnace state. All durations are integer ticks.
use crate::inventory::{subtract, Stack};
use world::{
    io::{DecodeError, Reader, Writer},
    items, smelting,
};
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Furnace {
    pub slots: [Option<Stack>; 3],
    pub burn: u32,
    pub total: u32,
    pub progress: u16,
}
impl Furnace {
    pub fn tick(&mut self) {
        let output = self.slots[0].and_then(|s| smelting::output(s.item));
        let ready = output.is_some_and(|item| {
            self.slots[2]
                .is_none_or(|s| s.item == item && s.count < items::info(item).unwrap().max_stack)
        });
        if ready && self.burn == 0 {
            if let Some(ticks) = self.slots[1].and_then(|s| items::info(s.item)?.fuel) {
                subtract(&mut self.slots[1], 1);
                self.burn = ticks;
                self.total = ticks;
            }
        }
        if self.burn == 0 {
            self.progress = 0;
            return;
        }
        self.burn -= 1;
        if !ready {
            self.progress = 0;
            return;
        }
        self.progress += 1;
        if self.progress == smelting::SMELT_TICKS {
            subtract(&mut self.slots[0], 1);
            self.slots[2] = Some(Stack {
                item: output.unwrap(),
                count: self.slots[2].map_or(1, |s| s.count + 1),
            });
            self.progress = 0;
        }
    }
    pub fn write(&self, w: &mut Writer) {
        for s in self.slots {
            w.u16(s.map_or(0, |s| s.item));
            w.u8(s.map_or(0, |s| s.count));
        }
        w.raw(&self.burn.to_be_bytes());
        w.raw(&self.total.to_be_bytes());
        w.u16(self.progress);
    }
    pub fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let mut f = Self::default();
        for s in &mut f.slots {
            let item = r.u16()?;
            let count = r.u8()?;
            if item == 0 {
                if count != 0 {
                    return Err(DecodeError);
                }
            } else {
                let stack = Stack { item, count };
                if !crate::inventory::valid(stack) {
                    return Err(DecodeError);
                }
                *s = Some(stack);
            }
        }
        f.burn = r.i32()? as u32;
        f.total = r.i32()? as u32;
        f.progress = r.u16()?.min(smelting::SMELT_TICKS - 1);
        if f.burn > f.total {
            return Err(DecodeError);
        }
        Ok(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_saved_durations_after_balance_changes() {
        let total = u32::MAX;
        assert!(!items::ITEMS.iter().any(|i| i.fuel == Some(total)));
        for progress in [
            0,
            smelting::SMELT_TICKS - 1,
            smelting::SMELT_TICKS,
            u16::MAX,
        ] {
            let mut f = Furnace {
                slots: [stack("iron_ore", 1), None, None],
                burn: total,
                total,
                progress,
            };
            let mut w = Writer::new();
            f.write(&mut w);
            f.progress = progress.min(smelting::SMELT_TICKS - 1);
            assert_eq!(Furnace::read(&mut Reader::new(&w.finish())).unwrap(), f);
        }
    }
    #[test]
    fn rejects_saved_burn_greater_than_total() {
        for (burn, total) in [(1, 0), (1001, 1000)] {
            let f = Furnace {
                burn,
                total,
                ..Furnace::default()
            };
            let mut w = Writer::new();
            f.write(&mut w);
            assert!(Furnace::read(&mut Reader::new(&w.finish())).is_err());
        }
    }
    fn stack(name: &str, count: u8) -> Option<Stack> {
        Some(Stack {
            item: items::by_name(name).unwrap(),
            count,
        })
    }
    #[test]
    fn smelts_each_160_ticks_and_burns_without_a_viewer() {
        let mut f = Furnace {
            slots: [stack("iron_ore", 3), stack("coal", 1), None],
            ..Furnace::default()
        };
        for n in 1..=480 {
            f.tick();
            assert_eq!(f.slots[2].map_or(0, |s| s.count), (n / 160) as u8);
        }
        assert_eq!(f.slots[0], None);
        assert_eq!((f.burn, f.total, f.progress), (1120, 1600, 0));
        for _ in 0..1120 {
            f.tick();
        }
        f.slots[0] = stack("iron_ore", 1);
        for _ in 0..160 {
            f.tick();
        }
        assert_eq!(f.slots[2], stack("iron_ingot", 3));
        f.slots[1] = stack("coal", 1);
        for _ in 0..160 {
            f.tick();
        }
        assert_eq!(f.slots[2], stack("iron_ingot", 4));
    }
    #[test]
    fn smelts_raw_beef_into_cooked_beef() {
        let mut f = Furnace {
            slots: [stack("raw_beef", 1), stack("coal", 1), None],
            ..Furnace::default()
        };
        for _ in 1..smelting::SMELT_TICKS {
            f.tick();
            assert_eq!(f.slots[2], None);
        }
        f.tick();
        assert_eq!(f.slots[0], None);
        assert_eq!(f.slots[2], stack("cooked_beef", 1));
    }

    #[test]
    fn short_fuel_resets_progress_and_blocked_output_does_not_consume_fuel() {
        let mut f = Furnace {
            slots: [stack("iron_ore", 3), stack("stick", 1), None],
            ..Furnace::default()
        };
        for _ in 0..80 {
            f.tick();
        }
        assert_eq!((f.burn, f.progress), (0, 80));
        f.tick();
        assert_eq!(f.progress, 0);
        assert_eq!(f.slots[2], None);
        for out in [stack("iron_ingot", 64), stack("copper_ingot", 1)] {
            f.slots[1] = stack("coal", 1);
            f.slots[2] = out;
            for _ in 0..160 {
                f.tick();
            }
            assert_eq!(f.slots[1], stack("coal", 1));
            assert_eq!(f.slots[2], out);
        }
        f.slots[2] = None;
        f.tick();
        f.slots[2] = stack("copper_ingot", 1);
        f.tick();
        assert_eq!((f.burn, f.progress), (1598, 0));
    }
}
