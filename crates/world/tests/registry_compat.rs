use world::blocks::*;

// Captured from the handwritten registry before introducing code generation.
#[test]
fn registry_matches_pre_generation_snapshot() {
    // Preserve the historical snapshot; only leaf internal-face culling changed.
    let expected = include_str!("registry-v1.txt").replacen(
        "12: oak_leaves Cube Cutout false true false 1 0",
        "12: oak_leaves Cube Cutout false true true 1 0",
        1,
    );
    assert_eq!(snapshot(), expected);
    assert_eq!(
        [
            AIR,
            STONE,
            GRASS_BLOCK,
            DIRT,
            COBBLESTONE,
            OAK_PLANKS,
            BEDROCK,
            SAND,
            OAK_LOG,
            BRICKS,
            LAMP_BLOCK,
            GLASS,
            OAK_LEAVES,
            WATER,
            OAK_SLAB,
            COBBLESTONE_SLAB,
            RED_FLOWER,
            YELLOW_FLOWER,
            SHORT_GRASS,
            OAK_STAIRS,
            COBBLESTONE_STAIRS,
            OAK_FENCE,
            COUNT,
            LEGACY_COUNT
        ],
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 21, 22, 23, 31, 39, 49, 14]
    );
    for state in 0..COUNT {
        assert_eq!(parse_state(&state_name(state)), Some(state));
    }
}

fn snapshot() -> String {
    use std::fmt::Write;
    let old_textures = &TEXTURES[..18];
    let mut out = format!(
        "textures={old_textures:?}\nregistry={:?}\n",
        registry().filter(|b| b.first < 40).collect::<Vec<_>>()
    );
    for state in 0..40 {
        let b = info(state);
        writeln!(
            out,
            "{state}: {} {:?} {:?} {} {} {} {} {} {:?} {:?} {:?}",
            state_name(state),
            b.model,
            b.layer,
            b.occludes,
            b.solid,
            b.cull_same,
            b.opacity,
            b.emission,
            b.tex,
            b.tint,
            properties(state)
        )
        .unwrap();
        for purpose in [
            ShapePurpose::Collision,
            ShapePurpose::Selection,
            ShapePurpose::Render,
        ] {
            for neighbor in [AIR, STONE, OAK_STAIRS, OAK_STAIRS + 5, OAK_FENCE] {
                let mut boxes = Vec::new();
                shape_boxes(state, |_, _, _| neighbor, purpose, |b| boxes.push(b));
                writeln!(out, "  {purpose:?}/{neighbor}: {boxes:?}").unwrap();
            }
        }
    }
    out
}

#[test]
fn biome_ids_and_original_tint_palette_match() {
    use world::biomes::BIOMES;

    let expected = [
        ("mild_meadow", [124, 184, 84], [88, 152, 70], [62, 128, 200]),
        ("dry_sands", [190, 182, 100], [158, 160, 78], [60, 150, 190]),
        ("rain_grove", [72, 170, 74], [48, 140, 58], [56, 132, 170]),
        ("sun_steppe", [176, 178, 88], [140, 150, 70], [66, 140, 190]),
        ("quiet_snow", [128, 176, 140], [96, 148, 120], [58, 96, 170]),
        ("reed_mire", [98, 138, 72], [90, 124, 60], [76, 112, 96]),
        ("open_tide", [118, 178, 86], [86, 150, 72], [52, 104, 196]),
        (
            "silent_floe",
            [128, 176, 140],
            [96, 148, 120],
            [56, 84, 150],
        ),
        ("clear_shoal", [126, 186, 90], [90, 154, 74], [64, 170, 200]),
        (
            "pale_strand",
            [150, 186, 96],
            [110, 156, 78],
            [64, 150, 200],
        ),
        (
            "shingle_edge",
            [122, 160, 104],
            [96, 136, 88],
            [60, 110, 160],
        ),
        (
            "bare_ridge",
            [134, 170, 112],
            [100, 140, 92],
            [60, 120, 190],
        ),
        (
            "white_crest",
            [128, 176, 150],
            [96, 148, 124],
            [58, 100, 176],
        ),
    ];
    assert_eq!(BIOMES.len(), expected.len());
    for (biome, (name, grass, leaves, water)) in BIOMES.iter().zip(expected) {
        assert_eq!(biome.name, name);
        assert_eq!(biome.grass_color, grass);
        assert_eq!(biome.leaves_color, leaves);
        assert_eq!(biome.water_color, water);
    }
}

#[test]
fn biome_tree_recipes_match_original_specification() {
    use world::biomes::{TreeShape::*, BIOMES};
    let expected = [
        (0.03, Round, [4, 6]),
        (0.0, None, [0, 0]),
        (0.32, Round, [6, 9]),
        (0.008, Round, [4, 5]),
        (0.08, Cone, [6, 9]),
        (0.12, Round, [4, 6]),
        (0.0, None, [0, 0]),
        (0.0, None, [0, 0]),
        (0.0, None, [0, 0]),
        (0.0, None, [0, 0]),
        (0.0, None, [0, 0]),
        (0.01, Cone, [5, 7]),
        (0.0, None, [0, 0]),
    ];
    assert_eq!(BIOMES.len(), expected.len());
    for (b, recipe) in BIOMES.iter().zip(expected) {
        assert_eq!(
            (b.tree_density, b.tree_shape, b.tree_height),
            recipe,
            "{}",
            b.name
        );
    }
}

#[test]
fn original_ore_ids_textures_and_stone_properties() {
    let stone = info(STONE);
    for (id, name, texture) in [
        (COAL_ORE, "coal_ore", 23),
        (COPPER_ORE, "copper_ore", 24),
        (IRON_ORE, "iron_ore", 25),
        (GOLD_ORE, "gold_ore", 26),
    ] {
        assert_eq!(id, 45 + texture - 23);
        assert_eq!(parse_state(name), Some(id));
        assert_eq!(TEXTURES[texture as usize], name);
        let ore = info(id);
        assert_eq!(ore.model, stone.model);
        assert_eq!(ore.layer, stone.layer);
        assert_eq!(ore.occludes, stone.occludes);
        assert_eq!(ore.solid, stone.solid);
        assert_eq!(ore.opacity, 15);
        assert_eq!(ore.emission, 0);
        assert_eq!(ore.tex, [texture; 6]);
    }
}
