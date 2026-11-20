use world::blocks::*;

// Captured from the handwritten registry before introducing code generation.
#[test]
fn registry_matches_pre_generation_snapshot() {
    // Preserve the historical snapshot except for intentional render changes.
    let expected = include_str!("registry-v1.txt").replacen(
        "12: oak_leaves Cube Cutout false true false 1 0",
        "12: oak_leaves Cube Cutout false true true 1 0",
        1,
    ).replacen(
        "2: grass_block Cube Opaque true true false 15 0 [3, 1, 2, 2, 2, 2] [false, true, false, false, false, false]",
        "2: grass_block Cube Opaque true true false 15 0 [3, 1, 2, 2, 2, 2] [false, true, true, true, true, true]",
        1,
    ).replacen(
        "13: water Cube Translucent false false true 1 0 [14, 14, 14, 14, 14, 14]",
        "13: water Cube Translucent false false true 1 0 [14, 14, 35, 35, 35, 35]",
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
            PLACED_OAK_LEAVES,
            FARMLAND,
            WHEAT,
            FLOWING_WATER,
            FALLING_WATER,
            LAVA,
            FLOWING_LAVA,
            FALLING_LAVA,
            OBSIDIAN,
            WHITE_WOOL,
            TORCH,
            WALL_TORCH,
            COUNT,
            LEGACY_COUNT
        ],
        [
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 21, 22, 23, 31, 39, 51, 52,
            54, 62, 69, 70, 71, 74, 75, 76, 77, 78, 82, 14
        ]
    );
    for state in 0..COUNT {
        assert_eq!(parse_state(&state_name(state)), Some(state));
    }
}

#[test]
fn flowing_water_appends_eight_states_with_the_water_properties() {
    let water = info(WATER);
    for (i, level) in ["1", "2", "3", "4", "5", "6", "7", "falling"]
        .into_iter()
        .enumerate()
    {
        let state = FLOWING_WATER + i as u16;
        assert_eq!(state_name(state), format!("flowing_water[level={level}]"));
        assert_eq!(properties(state), &[("level", level)]);
        assert!(is_water(state));
        let flow = info(state);
        assert_eq!(
            (flow.solid, flow.layer, flow.cull_same),
            (water.solid, water.layer, water.cull_same)
        );
        assert_eq!(
            (flow.dig_ticks, flow.opacity, flow.emission),
            (water.dig_ticks, water.opacity, water.emission)
        );
        assert_eq!((flow.tex, flow.tint), (water.tex, water.tint));
        assert_eq!(world::items::for_block(state), None);
    }
    for (name, id, max_stack) in [("bucket", 57, 16), ("water_bucket", 58, 1)] {
        assert_eq!(world::items::by_name(name), Some(id));
        let item = world::items::info(id).unwrap();
        assert_eq!(item.max_stack, max_stack);
        assert_eq!(item.block, None);
    }
}

#[test]
fn lava_and_obsidian_are_appended_with_their_render_mining_and_item_properties() {
    let states = ["1", "2", "3", "falling"];
    for (i, level) in states.into_iter().enumerate() {
        let state = FLOWING_LAVA + i as u16;
        assert_eq!(properties(state), &[("level", level)]);
        assert_eq!(world::items::for_block(state), None);
    }
    assert_eq!(block(LAVA).unwrap().count, 1);
    assert_eq!(block(FLOWING_LAVA).unwrap().count, 4);
    for state in LAVA..=FALLING_LAVA {
        let lava = info(state);
        assert!(is_fluid(state) && is_lava(state) && !is_water(state));
        assert!(!lava.solid && !lava.occludes && lava.cull_same);
        assert_eq!(lava.layer, RenderLayer::Opaque);
        assert_eq!(lava.emission, info(LAMP_BLOCK).emission);
        assert_eq!(lava.dig_ticks, None);
        assert_eq!(lava.tint, [false; 6]);
        assert!(lava.tex.iter().all(|&tex| TEXTURES[tex as usize] == "lava"));
    }
    let obsidian = info(OBSIDIAN);
    assert!(is_full_opaque_cube(OBSIDIAN));
    assert!(!is_fluid(OBSIDIAN));
    assert_eq!(obsidian.tool, Some(world::items::ToolKind::Pickaxe));
    assert_eq!((obsidian.min_tier, obsidian.dig_ticks), (4, Some(400)));
    for (name, id, max_stack, block) in [
        ("lava", 59, 64, Some(LAVA)),
        ("lava_bucket", 60, 1, None),
        ("obsidian", 61, 64, Some(OBSIDIAN)),
    ] {
        assert_eq!(world::items::by_name(name), Some(id));
        let item = world::items::info(id).unwrap();
        assert_eq!((item.max_stack, item.block), (max_stack, block));
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
