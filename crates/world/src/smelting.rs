//! Data-driven single-item smelting, measured in integer ticks.
pub const SMELT_TICKS: u16 = 160;
include!(concat!(env!("OUT_DIR"), "/smelting.rs"));
pub fn output(input: u16) -> Option<u16> {
    RECIPES.iter().find(|r| r.0 == input).map(|r| r.1)
}
