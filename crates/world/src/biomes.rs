//! Original climate representatives and surface recipes.
use crate::BlockState;

pub type BiomeId = u16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerrainKind {
    Sea,
    Shallows,
    Beach,
    Land,
    Mountain,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Biome {
    pub terrain: TerrainKind,
    pub depth: u8,
    pub underwater: BlockState,
    pub slope: BlockState,
    pub freeze: bool,
    pub name: &'static str,
    pub surface: BlockState,
    pub subsurface: BlockState,
    pub grass_color: [u8; 3],
    pub leaves_color: [u8; 3],
    pub water_color: [u8; 3],
    /// Climate representative is the midpoint of each normalized range.
    pub temperature: [f64; 2],
    pub humidity: [f64; 2],
}

include!(concat!(env!("OUT_DIR"), "/biomes.rs"));

/// Nearest climate representative of the terrain kind. Registry order breaks ties.
/// Every kind has at least one entry (validated during the build).
pub fn select(temperature: f64, humidity: f64, kind: TerrainKind) -> BiomeId {
    BIOMES
        .iter()
        .enumerate()
        .filter(|(_, b)| b.terrain == kind)
        .min_by(|(_, a), (_, b)| {
            let distance = |b: &Biome| {
                let dt = temperature - (b.temperature[0] + b.temperature[1]) * 0.5;
                let dh = humidity - (b.humidity[0] + b.humidity[1]) * 0.5;
                dt * dt + dh * dh
            };
            distance(a).total_cmp(&distance(b))
        })
        .unwrap()
        .0 as BiomeId
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks;

    #[test]
    fn original_biomes_have_valid_surface_blocks() {
        assert_eq!(BIOMES.len(), 13);
        assert_eq!(BIOMES[0].name, "mild_meadow");
        assert_eq!(BIOMES[0].surface, blocks::GRASS_BLOCK);
        assert_eq!(BIOMES[0].subsurface, blocks::DIRT);
        assert_eq!(BIOMES[1].surface, blocks::SAND);
        for b in BIOMES {
            assert!(blocks::is_valid(b.surface) && blocks::is_valid(b.subsurface));
        }
    }
}
