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
fn one_new_entry_adds_a_block_and_texture() {
    // Append to the atlas rather than inserting, keeping previous layer indices stable.
    let data = BLOCKS.replacen(
        "\"short_grass\",\n]",
        "\"short_grass\", \"test_clay\",\n]",
        1,
    );
    assert_ne!(data, BLOCKS);
    let data =
        format!("{data}\n[[blocks]]\nname = \"test_clay\"\nid = 40\ntexture = \"test_clay\"\n");
    let output = generate_fixture(&data, BIOMES).unwrap();
    assert!(output.contains("pub const TEST_CLAY: BlockState = 40;"));
    assert!(output.contains("pub const COUNT: BlockState = 41;"));
    assert!(output.contains("tex: [18, 18, 18, 18, 18, 18]"));
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
        id = 40
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
    let data = format!("{BLOCKS}\n[[blocks]]\nname = 'test'\nid = 40\ntop = 'stone'\nbottom = 'dirt'\nside = 'sand'\ntint = true");
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
