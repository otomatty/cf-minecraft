//! Original biome metadata reserved for future terrain generation.
use crate::BlockState;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Biome {
    pub name: &'static str,
    pub surface: BlockState,
    pub subsurface: BlockState,
    pub grass_color: [u8; 3],
    pub leaves_color: [u8; 3],
    /// Suggested normalized climate ranges, inclusive.
    pub temperature: [f64; 2],
    pub humidity: [f64; 2],
}

include!(concat!(env!("OUT_DIR"), "/biomes.rs"));

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks;

    #[test]
    fn original_biomes_have_valid_surface_blocks() {
        assert_eq!(BIOMES.len(), 2);
        assert_eq!(BIOMES[0].name, "mild_meadow");
        assert_eq!(BIOMES[0].surface, blocks::GRASS_BLOCK);
        assert_eq!(BIOMES[0].subsurface, blocks::DIRT);
        assert_eq!(BIOMES[1].surface, blocks::SAND);
        for b in BIOMES {
            assert!(blocks::is_valid(b.surface) && blocks::is_valid(b.subsurface));
        }
    }
}
