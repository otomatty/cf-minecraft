//! World data model: block registry, paletted sections, chunks.
//!
//! Only ordered collections (`BTreeMap`/`BTreeSet`) are allowed in the core.
//! Hash maps iterate in an order that depends on a random seed, which would
//! break "same inputs, same world" across hosts.

pub mod blocks;
pub mod chunk;
pub mod io;
pub mod palette;

pub use chunk::{Chunk, Fnv64, Section, World};
pub use palette::PalettedContainer;

/// Lowest block Y of the overworld.
pub const MIN_Y: i32 = -64;
/// Total build height in blocks (Y -64..=319).
pub const HEIGHT: i32 = 384;
/// 16-block-tall sections per chunk column.
pub const SECTIONS: usize = (HEIGHT / 16) as usize;

pub type BlockState = u16;

/// Section index (0..24) containing world Y, if inside the build height.
#[inline]
pub fn section_index(y: i32) -> Option<usize> {
    let rel = y - MIN_Y;
    if (0..HEIGHT).contains(&rel) {
        Some((rel >> 4) as usize)
    } else {
        None
    }
}
