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
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../target/registry-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("blocks.toml"), blocks).unwrap();
    fs::write(dir.join("biomes.toml"), biomes).unwrap();
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
        "\"coarse_dirt\",\n]",
        "\"coarse_dirt\", \"test_clay\",\n]",
        1,
    );
    assert_ne!(data, BLOCKS);
    let data =
        format!("{data}\n[[blocks]]\nname = \"test_clay\"\nid = 45\ntexture = \"test_clay\"\n");
    let output = generate_fixture(&data, BIOMES).unwrap();
    assert!(output.contains("pub const TEST_CLAY: BlockState = 45;"));
    assert!(output.contains("pub const COUNT: BlockState = 46;"));
    assert!(output.contains("tex: [23, 23, 23, 23, 23, 23]"));
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
        id = 45
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
    let data = format!("{BLOCKS}\n[[blocks]]\nname = 'test'\nid = 45\ntop = 'stone'\nbottom = 'dirt'\nside = 'sand'\ntint = true");
    let output = generate_fixture(&data, BIOMES).unwrap();
    assert!(output.contains(
        "name: \"test\", tex: [3, 0, 7, 7, 7, 7], tint: [true, true, true, true, true, true]"
    ));
}

#[test]
fn omitted_defaults_match_explicit_values() {
    let explicit = BLOCKS.replacen(
        "name = \"stone\"\nid = 1\ntexture = \"stone\"",
        "name = \"stone\"\nid = 1\ntexture = \"stone\"\nmodel = \"cube\"\nlayer = \"opaque\"\noccludes = true\nsolid = true\ncull_same = false\nopacity = 15\nemission = 0\ntint = false", 1);
    assert_ne!(explicit, BLOCKS);
    assert_eq!(
        generate_fixture(BLOCKS, BIOMES).unwrap(),
        generate_fixture(&explicit, BIOMES).unwrap()
    );
}
