//! Generated, ordered recipe data. Matching belongs to the simulation.
#[derive(Clone, Copy, Debug)]
pub struct Recipe {
    /// Zero width denotes a shapeless recipe.
    pub width: usize,
    pub height: usize,
    pub ingredients: &'static [u16],
    pub item: u16,
    pub count: u8,
}
include!(concat!(env!("OUT_DIR"), "/recipes.rs"));
