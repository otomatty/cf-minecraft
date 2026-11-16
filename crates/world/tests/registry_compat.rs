use world::blocks::*;

// Captured from the handwritten registry before introducing code generation.
#[test]
fn registry_matches_pre_generation_snapshot() {
    assert_eq!(snapshot(), include_str!("registry-v1.txt"));
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
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 21, 22, 23, 31, 39, 45, 14]
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
