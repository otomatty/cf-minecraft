use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

const BLOCKS: &str = include_str!("../../../data/registry/blocks.toml");
const BIOMES: &str = include_str!("../../../data/registry/biomes.toml");
static NEXT: AtomicUsize = AtomicUsize::new(0);

// Exercise the exact build pipeline without changing checked-in data.
fn generate_fixture(blocks: &str, biomes: &str) -> Result<String, String> {
    generate_items_fixture(
        blocks,
        biomes,
        include_str!("../../../data/registry/items.toml"),
    )
}

fn generate_items_fixture(blocks: &str, biomes: &str, items: &str) -> Result<String, String> {
    generate_recipes_fixture(
        blocks,
        biomes,
        items,
        include_str!("../../../data/registry/recipes.toml"),
    )
}
fn generate_recipes_fixture(
    blocks: &str,
    biomes: &str,
    items: &str,
    recipes: &str,
) -> Result<String, String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../target/registry-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("blocks.toml"), blocks).unwrap();
    fs::write(dir.join("biomes.toml"), biomes).unwrap();
    fs::write(dir.join("items.toml"), items).unwrap();
    fs::write(dir.join("recipes.toml"), recipes).unwrap();
    let output = std::process::Command::new(env!("REGISTRY_BUILD_SCRIPT"))
        .arg("--registry-fixture")
        .arg(&dir)
        .arg(&dir)
        .output()
        .unwrap();
    let result = if output.status.success() {
        Ok(fs::read_to_string(dir.join("blocks.rs")).unwrap())
    } else {
        Err(String::from_utf8(output.stderr).unwrap())
    };
    fs::remove_dir_all(dir).unwrap();
    result
}

#[test]
fn data_errors_identify_the_problem() {
    for (from, to, message) in [
        ("name = \"stone\"", "name = \"air\"", "duplicate block air"),
        ("id = 1\n", "id = 0\n", "state ID collision or gap"),
        ("model = \"cross\"", "model = \"unknown\"", "unknown model"),
        ("opacity = 1\n", "opacity = 16\n", "opacity/emission"),
        (
            "texture = \"stone\"",
            "texture = \"missing\"",
            "unknown texture missing",
        ),
        ("solid = false", "typo = false", "unknown field `typo`"),
        (
            "textures = [",
            "textures = [\"stone\",",
            "duplicate texture stone",
        ),
        (
            "tint = [\"top\"]",
            "tint = [\"typo\"]",
            "unknown tint face typo",
        ),
        (
            "texture = \"stone\"",
            "top = \"stone\"",
            "missing texture for bottom",
        ),
        (
            "type\", \"top",
            "type\", \"bottom",
            "duplicate state properties",
        ),
    ] {
        assert!(BLOCKS.contains(from), "fixture pattern not found: {from}");
        let error = generate_fixture(&BLOCKS.replacen(from, to, 1), BIOMES).unwrap_err();
        assert!(error.contains(message), "{error}");
    }
    let error = generate_fixture(BLOCKS, &BIOMES.replace("grass_block", "missing")).unwrap_err();
    assert!(error.contains("unknown block missing"));
    let error = generate_fixture(BLOCKS, &BIOMES.replace("0.25", "1.25")).unwrap_err();
    assert!(error.contains("expected ordered range"));
}

#[test]
fn biome_recipes_validate_all_block_references_and_terrain_kinds() {
    for field in ["subsurface", "underwater", "slope"] {
        let from = format!(
            "{field} = \"{}\"",
            if field == "subsurface" {
                "dirt"
            } else if field == "underwater" {
                "sand"
            } else {
                "stone"
            }
        );
        let to = format!("{field} = \"missing\"");
        assert!(BIOMES.contains(&from));
        assert!(generate_fixture(BLOCKS, &BIOMES.replacen(&from, &to, 1))
            .unwrap_err()
            .contains("unknown block missing"));
    }
    assert!(
        generate_fixture(BLOCKS, &BIOMES.replace("depth = 3", "depth = 9"))
            .unwrap_err()
            .contains("depth must be <= 8")
    );
    assert!(generate_fixture(
        BLOCKS,
        &BIOMES.replacen("terrain = \"Land\"", "terrain = \"Unknown\"", 1)
    )
    .unwrap_err()
    .contains("unknown terrain kind"));
    assert!(generate_fixture(
        BLOCKS,
        &BIOMES.replace("terrain = \"Mountain\"", "terrain = \"Land\"")
    )
    .unwrap_err()
    .contains("missing terrain kind Mountain"));
    assert!(generate_fixture(BLOCKS, &BIOMES.replace("slope = \"stone\"\n", "")).is_ok());
}

#[test]
fn one_new_entry_adds_a_block_and_texture() {
    // Append to the atlas rather than inserting, keeping previous layer indices stable.
    let data = BLOCKS.replacen(
        "\"crafting_table_bottom\",\n]",
        "\"crafting_table_bottom\", \"test_clay\",\n]",
        1,
    );
    assert_ne!(data, BLOCKS);
    let data =
        format!("{data}\n[[blocks]]\nname = \"test_clay\"\nid = 50\ndig_ticks = 12\ntexture = \"test_clay\"\n");
    let output = generate_fixture(&data, BIOMES).unwrap();
    assert!(output.contains("pub const TEST_CLAY: BlockState = 50;"));
    assert!(output.contains("pub const COUNT: BlockState = 51;"));
    assert!(output.contains("tex: [30, 30, 30, 30, 30, 30]"));
}

#[test]
fn toml_syntax_and_unicode_are_checked() {
    let escaped = BLOCKS.replacen("texture = \"stone\"", r#"texture = "\u0073tone""#, 1);
    assert_ne!(escaped, BLOCKS);
    assert_eq!(
        generate_fixture(&escaped, BIOMES).unwrap(),
        generate_fixture(BLOCKS, BIOMES).unwrap()
    );
    for data in [
        "legacy_count = 14\nlegacy_count = 14",
        "textures = [",
        "legacy_count = 01",
        "legacy_count = 1e",
        r#"textures = ["\uD800"]"#,
        r#"textures = ["\あ"]"#,
    ] {
        assert!(generate_fixture(data, BIOMES)
            .unwrap_err()
            .contains("blocks.toml"));
    }
}

#[test]
fn texture_and_tint_shorthands_resolve_in_face_order() {
    let data = format!(
        r#"{BLOCKS}
        [[blocks]]
        name = "test"
        id = 50
        dig_ticks = 12
        texture = "stone"
        top = "grass_block_top"
        side = "grass_block_side"
        north = "dirt"
        east = "oak_log"
        tint = ["top", "side"]
    "#
    );
    let output = generate_fixture(&data, BIOMES).unwrap();
    assert!(output.contains(
        "name: \"test\", tex: [0, 1, 3, 2, 2, 8], tint: [false, true, true, true, true, true]"
    ));
    let data = format!("{BLOCKS}\n[[blocks]]\nname = 'test'\nid = 50\ndig_ticks = 12\ntop = 'stone'\nbottom = 'dirt'\nside = 'sand'\ntint = true");
    let output = generate_fixture(&data, BIOMES).unwrap();
    assert!(output.contains(
        "name: \"test\", tex: [3, 0, 7, 7, 7, 7], tint: [true, true, true, true, true, true]"
    ));
}

#[test]
fn omitted_defaults_match_explicit_values() {
    let explicit = BLOCKS.replacen(
        "name = \"stone\"\ntool = \"pickaxe\"\nmin_tier = 1\ndig_ticks = 70\nid = 1\ntexture = \"stone\"",
        "name = \"stone\"\ntool = \"pickaxe\"\nmin_tier = 1\ndig_ticks = 70\nid = 1\ntexture = \"stone\"\nmodel = \"cube\"\nlayer = \"opaque\"\noccludes = true\nsolid = true\ncull_same = false\nopacity = 15\nemission = 0\ntint = false", 1);
    assert_ne!(explicit, BLOCKS);
    assert_eq!(
        generate_fixture(BLOCKS, BIOMES).unwrap(),
        generate_fixture(&explicit, BIOMES).unwrap()
    );
}

#[test]
fn biome_colors_are_required_rgb_bytes_and_unknown_fields_are_rejected() {
    for (field, value) in [
        ("grass_color", "[124, 184, 84]"),
        ("leaves_color", "[88, 152, 70]"),
        ("water_color", "[62, 128, 200]"),
    ] {
        let line = format!("{field} = {value}\n");
        assert!(BIOMES.contains(&line));
        let error = generate_fixture(BLOCKS, &BIOMES.replacen(&line, "", 1)).unwrap_err();
        assert!(
            error.contains(&format!("missing field `{field}`")),
            "{error}"
        );
        for invalid in ["[256, 0, 0]", "[-1, 0, 0]", "[0, 0]", "[0, 0, 0, 0]"] {
            let error = generate_fixture(
                BLOCKS,
                &BIOMES.replacen(&line, &format!("{field} = {invalid}\n"), 1),
            )
            .unwrap_err();
            assert!(error.contains("biomes.toml"), "{error}");
        }
    }
    let error =
        generate_fixture(BLOCKS, &BIOMES.replacen("water_color", "water_colour", 1)).unwrap_err();
    assert!(error.contains("unknown field `water_colour`"), "{error}");
}

#[test]
fn tree_data_is_required_and_validated() {
    for line in [
        "tree_density = 0.03\n",
        "tree_shape = \"round\"\n",
        "tree_height = [4, 6]\n",
    ] {
        assert!(BIOMES.contains(line));
        let field = line.split(" =").next().unwrap();
        let error = generate_fixture(BLOCKS, &BIOMES.replacen(line, "", 1)).unwrap_err();
        assert!(
            error.contains(&format!("missing field `{field}`")),
            "{error}"
        );
    }
    for (from, to, message) in [
        (
            "tree_density = 0.03",
            "tree_density = -0.1",
            "tree_density must be in 0..=1",
        ),
        (
            "tree_density = 0.03",
            "tree_density = 1.1",
            "tree_density must be in 0..=1",
        ),
        (
            "tree_density = 0.03",
            "tree_density = nan",
            "tree_density must be in 0..=1",
        ),
        (
            "tree_shape = \"round\"",
            "tree_shape = \"unknown\"",
            "unknown tree_shape",
        ),
        (
            "tree_shape = \"round\"",
            "tree_shape = \"none\"",
            "none requires zero",
        ),
        (
            "tree_height = [0, 0]",
            "tree_height = [0, 1]",
            "none requires zero",
        ),
        (
            "tree_height = [4, 6]",
            "tree_height = [2, 6]",
            "tree_height must satisfy",
        ),
        (
            "tree_height = [4, 6]",
            "tree_height = [7, 6]",
            "tree_height must satisfy",
        ),
        (
            "tree_height = [4, 6]",
            "tree_height = [4, 13]",
            "tree_height must satisfy",
        ),
        (
            "tree_density = 0.03",
            "tree_densitty = 0.03",
            "unknown field `tree_densitty`",
        ),
    ] {
        let error = generate_fixture(BLOCKS, &BIOMES.replacen(from, to, 1)).unwrap_err();
        assert!(error.contains(message), "{error}");
    }
}

#[test]
fn item_validation_and_optional_block() {
    let items = include_str!("../../../data/registry/items.toml");
    for (from, to, message) in [
        (
            "name = \"dirt\"",
            "name = \"stone\"",
            "duplicate item stone",
        ),
        ("id = 1\n", "id = 0\n", "must not be 0"),
        ("id = 2\n", "id = 1\n", "duplicate id 1"),
        (
            "block = \"stone\"",
            "block = \"missing\"",
            "unknown block missing",
        ),
        (
            "id = 1\n",
            "id = 1\nmax_stack = 0\n",
            "max_stack must be 1..=64",
        ),
        (
            "id = 1\n",
            "id = 1\nmax_stack = 65\n",
            "max_stack must be 1..=64",
        ),
    ] {
        let error =
            generate_items_fixture(BLOCKS, BIOMES, &items.replacen(from, to, 1)).unwrap_err();
        assert!(error.contains(message), "{error}");
    }
    assert!(generate_items_fixture(
        BLOCKS,
        BIOMES,
        &items.replacen("block = \"stone\"", "texture = \"stone\"\nmax_stack = 7", 1)
    )
    .is_ok());
}

#[test]
fn mining_metadata_is_required_exclusive_and_bounded() {
    for replacement in [
        "",
        "dig_ticks = -1\n",
        "dig_ticks = 65536\n",
        "dig_ticks = 70\nunbreakable = true\n",
        "unbreakable = false\n",
    ] {
        assert!(
            generate_fixture(&BLOCKS.replacen("dig_ticks = 70\n", replacement, 1), BIOMES).is_err()
        );
    }
}

#[test]
fn tools_and_harvest_requirements_are_validated() {
    let items = include_str!("../../../data/registry/items.toml");
    for (from, to, message) in [
        ("max_stack = 1", "max_stack = 2", "tool max_stack must be 1"),
        ("block = \"stone\"", "", "block or texture required"),
        ("tier = 1", "tier = 0", "tool tier must be 1..=4"),
        ("tier = 1", "tier = 5", "tool tier must be 1..=4"),
        (
            "kind = \"pickaxe\"",
            "kind = \"hammer\"",
            "unknown tool kind",
        ),
    ] {
        assert!(
            generate_items_fixture(BLOCKS, BIOMES, &items.replacen(from, to, 1))
                .unwrap_err()
                .contains(message)
        );
    }
    for (from, to) in [
        ("tool = \"pickaxe\"\n", ""),
        ("min_tier = 1", "min_tier = 5"),
        ("tool = \"pickaxe\"", "tool = \"hammer\""),
    ] {
        assert!(generate_fixture(&BLOCKS.replacen(from, to, 1), BIOMES).is_err());
    }
}

#[test]
fn crafting_recipe_validation() {
    let recipes = include_str!("../../../data/registry/recipes.toml");
    let items = include_str!("../../../data/registry/items.toml");
    for (from, to, message) in [
        ("oak_log", "missing", "unknown item"),
        ("item = \"stick\"", "item = \"missing\"", "unknown item"),
        ("count = 4", "count = 0", "invalid result count"),
        ("count = 4", "count = 65", "invalid result count"),
        ("[\"#\", \"#\"]", "[\"#\", \"##\"]", "unequal row lengths"),
        ("[\"#\", \"#\"]", "[\"?\", \"#\"]", "character missing"),
        ("key = {", "key = { \"x\" = \"oak_log\",", "unused key"),
        ("[\"oak_log\"]", "[]", "ingredients length"),
        ("[\"#\", \"#\"]", "[\"####\"]", "pattern width"),
        (
            "[\"#\", \"#\"]",
            "[\"#\",\"#\",\"#\",\"#\"]",
            "pattern height",
        ),
    ] {
        assert!(recipes.contains(from));
        let error = generate_recipes_fixture(BLOCKS, BIOMES, items, &recipes.replacen(from, to, 1))
            .unwrap_err();
        assert!(error.contains(message), "{error}");
    }
    for duplicate in [
        "[[recipes]]\ningredients = [\"oak_log\"]\nresult = { item = \"stick\", count = 1 }",
        "[[recipes]]\npattern = [\" x\", \" x\"]\nkey = { x = \"oak_planks\" }\nresult = { item = \"stick\", count = 1 }",
    ] {
        assert!(generate_recipes_fixture(BLOCKS,BIOMES,items,&format!("{recipes}\n{duplicate}")).unwrap_err().contains("duplicate recipe"));
    }
}
