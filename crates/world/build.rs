use serde::{de::DeserializeOwned, Deserialize};
use std::{collections::BTreeSet, fmt::Write, fs, path::Path};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Items {
    items: Vec<Item>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Item {
    name: String,
    id: u16,
    #[serde(default = "max_stack")]
    max_stack: u8,
    block: Option<String>,
    texture: Option<String>,
    tool: Option<Tool>,
    fuel: Option<u32>,
    food: Option<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tool {
    kind: String,
    tier: u8,
}
fn tool_kind(s: &str) -> &'static str {
    match s {
        "pickaxe" => "Pickaxe",
        "axe" => "Axe",
        "shovel" => "Shovel",
        "hoe" => "Hoe",
        _ => panic!("registry: unknown tool kind {s}"),
    }
}
fn max_stack() -> u8 {
    64
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    legacy_count: u16,
    textures: Vec<String>,
    blocks: Vec<Block>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Block {
    drop: Option<String>,
    dig_ticks: Option<u16>,
    tool: Option<String>,
    #[serde(default)]
    min_tier: u8,
    #[serde(default)]
    unbreakable: bool,
    name: String,
    id: u16,
    #[serde(default = "cube")]
    model: String,
    #[serde(default = "opaque")]
    layer: String,
    occludes: Option<bool>,
    solid: Option<bool>,
    cull_same: Option<bool>,
    opacity: Option<u8>,
    #[serde(default)]
    emission: u8,
    texture: Option<String>,
    #[serde(alias = "up")]
    top: Option<String>,
    #[serde(alias = "down")]
    bottom: Option<String>,
    side: Option<String>,
    north: Option<String>,
    south: Option<String>,
    west: Option<String>,
    east: Option<String>,
    #[serde(default)]
    tint: Tint,
    #[serde(default)]
    states: Vec<State>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Tint {
    All(bool),
    Faces(Vec<String>),
}
impl Default for Tint {
    fn default() -> Self {
        Self::All(false)
    }
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    #[serde(default)]
    properties: Vec<(String, String)>,
    model: Option<String>,
    occludes: Option<bool>,
    opacity: Option<u8>,
    texture: Option<String>,
    #[serde(alias = "up")]
    top: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Biomes {
    biomes: Vec<Biome>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Biome {
    tree_density: f64,
    tree_shape: String,
    tree_height: [u8; 2],
    terrain: String,
    depth: u8,
    underwater: String,
    #[serde(default = "stone")]
    slope: String,
    #[serde(default)]
    freeze: bool,
    name: String,
    surface: String,
    subsurface: String,
    #[serde(deserialize_with = "rgb")]
    grass_color: [u8; 3],
    #[serde(deserialize_with = "rgb")]
    leaves_color: [u8; 3],
    #[serde(deserialize_with = "rgb")]
    water_color: [u8; 3],
    temperature: [f64; 2],
    humidity: [f64; 2],
}
fn rgb<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<[u8; 3], D::Error> {
    let channels = Vec::<u8>::deserialize(deserializer)?;
    channels
        .try_into()
        .map_err(|_| serde::de::Error::custom("expected exactly 3 RGB bytes"))
}

fn stone() -> String {
    "stone".into()
}
fn cube() -> String {
    "cube".into()
}
fn opaque() -> String {
    "opaque".into()
}
fn read<T: DeserializeOwned>(path: &Path) -> T {
    println!("cargo:rerun-if-changed={}", path.display());
    let data = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    toml::from_str(&data).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}
impl Block {
    fn textures(&self, state: &State, atlas: &[String]) -> [u16; 6] {
        let resolve = |name: &String| {
            atlas
                .iter()
                .position(|t| t == name)
                .unwrap_or_else(|| panic!("blocks.toml: {}: unknown texture {name}", self.name))
                as u16
        };
        // Validate even an overridden value, so a typo cannot hide behind a more specific face.
        for name in [
            &self.texture,
            &self.top,
            &self.bottom,
            &self.side,
            &self.north,
            &self.south,
            &self.west,
            &self.east,
            &state.texture,
            &state.top,
        ]
        .into_iter()
        .flatten()
        {
            resolve(name);
        }
        [
            &self.bottom,
            if state.top.is_some() {
                &state.top
            } else {
                &self.top
            },
            &self.north,
            &self.south,
            &self.west,
            &self.east,
        ]
        .into_iter()
        .enumerate()
        .map(|(i, face)| {
            let name = face
                .as_ref()
                .or(if i >= 2 { self.side.as_ref() } else { None })
                .or(state.texture.as_ref())
                .or(self.texture.as_ref())
                .unwrap_or_else(|| {
                    panic!(
                        "blocks.toml: {}: missing texture for {}",
                        self.name,
                        ["bottom", "top", "north", "south", "west", "east"][i]
                    )
                });
            resolve(name)
        })
        .collect::<Vec<_>>()
        .try_into()
        .unwrap()
    }
    fn tint(&self) -> [bool; 6] {
        match &self.tint {
            Tint::All(all) => [*all; 6],
            Tint::Faces(faces) => {
                let mut result = [false; 6];
                for face in faces {
                    let indices: &[usize] = match face.as_str() {
                        "bottom" | "down" => &[0],
                        "top" | "up" => &[1],
                        "north" => &[2],
                        "south" => &[3],
                        "west" => &[4],
                        "east" => &[5],
                        "side" => &[2, 3, 4, 5],
                        _ => panic!("blocks.toml: {}: unknown tint face {face}", self.name),
                    };
                    for &i in indices {
                        result[i] = true;
                    }
                }
                result
            }
        }
    }
}
fn identifier(s: &str) {
    assert!(
        s.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && s.bytes()
                .enumerate()
                .all(|(i, c)| c.is_ascii_lowercase() || c == b'_' || (i > 0 && c.is_ascii_digit())),
        "registry: invalid name {s:?}; expected lowercase snake_case"
    );
}
fn model(s: &str) -> &'static str {
    match s {
        "cube" => "Model::Cube",
        "bottom_slab" => "Model::Boxes(&BOTTOM)",
        "top_slab" => "Model::Boxes(&TOP)",
        "cross" => "Model::Cross",
        "stairs" => "Model::Stairs",
        "fence" => "Model::Fence",
        _ => panic!("blocks.toml: unknown model {s:?}"),
    }
}
fn main() {
    // Integration tests run this same executable, keeping serde/toml build-only.
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() == 4 && args[1] == "--registry-fixture" {
        generate(Path::new(&args[2]), Path::new(&args[3]));
        return;
    }
    println!(
        "cargo:rustc-env=REGISTRY_BUILD_SCRIPT={}",
        std::env::current_exe().unwrap().display()
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/registry");
    let dest = std::env::var_os("OUT_DIR").unwrap();
    generate(&root, Path::new(&dest));
}

fn generate(root: &Path, dest: &Path) {
    let registry: Registry = read(&root.join("blocks.toml"));
    let mut names = BTreeSet::new();
    let textures = &registry.textures;
    let mut texture_names = BTreeSet::new();
    for t in textures {
        identifier(t);
        assert!(
            texture_names.insert(t),
            "blocks.toml: duplicate texture {t}"
        );
    }
    for b in &registry.blocks {
        assert!(
            b.unbreakable != b.dig_ticks.is_some(),
            "blocks.toml: {}: specify dig_ticks or unbreakable",
            b.name
        );
        assert!(b.min_tier <= 4, "blocks.toml: min_tier must be 0..=4");
        assert!(
            b.min_tier == 0 || b.tool.is_some(),
            "blocks.toml: min_tier requires tool"
        );
        if let Some(kind) = &b.tool {
            tool_kind(kind);
        }
        identifier(&b.name);
        model(&b.model);
        assert!(
            b.opacity.is_none_or(|v| v <= 15) && b.emission <= 15,
            "blocks.toml: {}: opacity/emission must be 0..=15",
            b.name
        );
        assert!(
            names.insert(b.name.as_str()),
            "blocks.toml: duplicate block {}",
            b.name
        );
        assert!(
            ![
                "count",
                "legacy_count",
                "textures",
                "info",
                "blocks",
                "properties",
                "bottom",
                "top",
                "plant",
                "full_box",
                "cardinal"
            ]
            .contains(&b.name.as_str()),
            "blocks.toml: reserved block name {}",
            b.name
        );
    }
    assert!(
        textures.len() <= u16::MAX as usize,
        "blocks.toml: too many textures"
    );
    let mut out = format!(
        "pub const LEGACY_COUNT: BlockState = {};\npub const TEXTURES: &[&str] = &{:?};\n",
        registry.legacy_count, textures
    );
    let mut infos = String::new();
    let mut props = String::new();
    let mut blocks = String::new();
    let mut count = 0usize;
    let mut state_names = BTreeSet::new();
    for b in &registry.blocks {
        assert_eq!(
            b.id as usize, count,
            "blocks.toml: {}: state ID collision or gap (expected {count})",
            b.name
        );
        let default = [State::default()];
        let states = if b.states.is_empty() {
            &default[..]
        } else {
            &b.states
        };
        let tint = b.tint();
        let layer = match b.layer.as_str() {
            "opaque" => "Opaque",
            "cutout" => "Cutout",
            "translucent" => "Translucent",
            other => panic!("blocks.toml: {}: unknown layer {other}", b.name),
        };
        writeln!(
            out,
            "pub const {}: BlockState = {};",
            b.name.to_ascii_uppercase(),
            b.id
        )
        .unwrap();
        writeln!(
            blocks,
            "Block {{ name: {:?}, first: {}, count: {} }},",
            b.name,
            b.id,
            states.len()
        )
        .unwrap();
        for s in states {
            let tex = b.textures(s, textures);
            let m = s.model.as_deref().unwrap_or(&b.model);
            let occludes = s
                .occludes
                .or(b.occludes)
                .unwrap_or(m == "cube" && b.layer == "opaque");
            let solid = b.solid.unwrap_or(m != "cross");
            let cull_same = b
                .cull_same
                .unwrap_or(m == "cube" && b.layer == "translucent");
            let opacity = s
                .opacity
                .or(b.opacity)
                .unwrap_or(if occludes { 15 } else { 0 });
            assert!(
                opacity <= 15 && b.emission <= 15,
                "blocks.toml: {}: opacity/emission must be 0..=15",
                b.name
            );
            let mut keys = BTreeSet::new();
            for (key, value) in &s.properties {
                identifier(key);
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    identifier(value);
                }
                assert!(
                    keys.insert(key),
                    "blocks.toml: {}: duplicate property {key}",
                    b.name
                );
            }
            assert!(
                state_names.insert((b.name.clone(), s.properties.clone())),
                "blocks.toml: {}: duplicate state properties",
                b.name
            );
            // The shape algorithm's facing/half ordering is part of the model contract.
            if m == "stairs" {
                assert!(
                    states
                        .iter()
                        .all(|s| s.model.as_deref().unwrap_or(&b.model) == "stairs"),
                    "blocks.toml: {}: stairs cannot mix models",
                    b.name
                );
                let i = count - b.id as usize;
                assert!(
                    states.len() == 8
                        && s.properties
                            == [
                                (
                                    "facing".into(),
                                    ["north", "south", "west", "east"][i / 2].into()
                                ),
                                ("half".into(), ["bottom", "top"][i % 2].into())
                            ],
                    "blocks.toml: {}: stairs require 8 ordered facing/half states",
                    b.name
                );
            }
            let tool = b.tool.as_ref().map_or("None".into(), |kind| {
                format!("Some(crate::items::ToolKind::{})", tool_kind(kind))
            });
            writeln!(infos, "BlockInfo {{ tool: {tool}, min_tier: {}, dig_ticks: {:?}, model: {}, layer: RenderLayer::{layer}, occludes: {}, solid: {}, cull_same: {}, opacity: {opacity}, emission: {}, name: {:?}, tex: {tex:?}, tint: {:?} }},", b.min_tier, b.dig_ticks, model(m), occludes, solid, cull_same, b.emission, b.name, tint).unwrap();
            let pairs: Vec<_> = s
                .properties
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            writeln!(props, "&{pairs:?},").unwrap();
            count += 1;
        }
    }
    assert!(count <= u16::MAX as usize, "blocks.toml: too many states");
    assert!(
        registry.legacy_count as usize <= count,
        "blocks.toml: legacy_count exceeds COUNT"
    );
    assert!(
        registry
            .blocks
            .first()
            .is_some_and(|b| b.name == "air" && b.id == 0),
        "blocks.toml: first block must be air at ID 0"
    );
    writeln!(out, "pub const COUNT: BlockState = {count};\nstatic INFO: [BlockInfo; {count}] = [{infos}];\nstatic BLOCKS: &[Block] = &[{blocks}];\nstatic PROPERTIES: &[&[(&str, &str)]] = &[{props}];").unwrap();
    fs::write(dest.join("blocks.rs"), out).unwrap();

    let items: Items = read(&root.join("items.toml"));
    let mut names = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut out = format!(
        "pub const COUNT: usize = {};\npub static ITEMS: &[ItemInfo] = &[\n",
        items.items.len()
    );
    for item in &items.items {
        identifier(&item.name);
        assert!(
            item.fuel.is_none_or(|v| v > 0),
            "items.toml: fuel must be positive"
        );
        assert!(
            item.food.is_none_or(|value| (1..=20).contains(&value)),
            "items.toml: food must be 1..=20"
        );
        assert!(
            names.insert(item.name.clone()),
            "items.toml: duplicate item {}",
            item.name
        );
        assert!(item.id != 0, "items.toml: item id must not be 0");
        assert!(ids.insert(item.id), "items.toml: duplicate id {}", item.id);
        assert!(
            (1..=64).contains(&item.max_stack),
            "items.toml: max_stack must be 1..=64"
        );
        assert!(
            item.block.is_some() || item.texture.is_some(),
            "items.toml: block or texture required"
        );
        if let Some(texture) = &item.texture {
            identifier(texture);
        }
        let tool = item.tool.as_ref().map_or("None".into(), |tool| {
            assert!(item.max_stack == 1, "items.toml: tool max_stack must be 1");
            assert!(
                (1..=4).contains(&tool.tier),
                "items.toml: tool tier must be 1..=4"
            );
            format!(
                "Some(Tool {{ kind: ToolKind::{}, tier: {} }})",
                tool_kind(&tool.kind),
                tool.tier
            )
        });
        let texture = item
            .texture
            .as_ref()
            .map_or("None".into(), |t| format!("Some({t:?})"));
        let block = item.block.as_ref().map(|name| {
            registry
                .blocks
                .iter()
                .find(|b| &b.name == name)
                .unwrap_or_else(|| panic!("items.toml: unknown block {name}"))
                .id
        });
        writeln!(
            out,
            "ItemInfo {{ id: {}, name: {:?}, max_stack: {}, block: {:?}, texture: {texture}, tool: {tool}, fuel: {:?}, food: {:?} }},",
            item.id, item.name, item.max_stack, block, item.fuel, item.food
        )
        .unwrap();
    }
    out.push_str("];\n");
    out.push_str("static MINING_DROPS: &[(&str, u16)] = &[\n");
    for block in &registry.blocks {
        if let Some(name) = &block.drop {
            let item = items
                .items
                .iter()
                .find(|item| &item.name == name)
                .unwrap_or_else(|| panic!("blocks.toml: {}: unknown drop item {name}", block.name));
            writeln!(out, "({:?}, {}),", block.name, item.id).unwrap();
        }
    }
    out.push_str("];\n");
    generate_loot(root, &mut out, &items.items);
    fs::write(dest.join("items.rs"), out).unwrap();

    generate_recipes(root, dest, &items.items);
    generate_smelting(root, dest, &items.items);

    let biomes: Biomes = read(&root.join("biomes.toml"));
    let mut names = BTreeSet::new();
    let mut out = String::from("pub const BIOMES: &[Biome] = &[\n");
    for kind in ["Sea", "Shallows", "Beach", "Land", "Mountain"] {
        assert!(
            biomes.biomes.iter().any(|b| b.terrain == kind),
            "biomes.toml: missing terrain kind {kind}"
        );
    }
    for b in biomes.biomes {
        assert!(
            ["Sea", "Shallows", "Beach", "Land", "Mountain"].contains(&b.terrain.as_str()),
            "biomes.toml: unknown terrain kind"
        );
        assert!(b.depth <= 8, "biomes.toml: depth must be <= 8");
        assert!(
            (0.0..=1.0).contains(&b.tree_density),
            "biomes.toml: tree_density must be in 0..=1"
        );
        let tree_shape = match b.tree_shape.as_str() {
            "none" => "None",
            "round" => "Round",
            "cone" => "Cone",
            _ => panic!("biomes.toml: unknown tree_shape"),
        };
        if tree_shape == "None" {
            assert!(
                b.tree_density == 0.0 && b.tree_height == [0, 0],
                "biomes.toml: none requires zero tree_density and tree_height"
            );
        } else {
            assert!(
                3 <= b.tree_height[0]
                    && b.tree_height[0] <= b.tree_height[1]
                    && b.tree_height[1] <= 12,
                "biomes.toml: tree_height must satisfy 3 <= min <= max <= 12"
            );
        }
        identifier(&b.name);
        assert!(
            names.insert(b.name.clone()),
            "biomes.toml: duplicate biome {}",
            b.name
        );
        let resolve = |name: &str| {
            registry
                .blocks
                .iter()
                .find(|b| b.name == name)
                .unwrap_or_else(|| panic!("biomes.toml: {}: unknown block {name}", b.name))
                .id
        };
        for range in [b.temperature, b.humidity] {
            assert!(
                range[0].is_finite()
                    && range[1].is_finite()
                    && range[0] >= 0.0
                    && range[1] <= 1.0
                    && range[0] <= range[1],
                "biomes.toml: {}: expected ordered range in 0..=1",
                b.name
            );
        }
        writeln!(out, "Biome {{ tree_density: {:?}, tree_shape: TreeShape::{}, tree_height: {:?}, terrain: TerrainKind::{}, depth: {}, underwater: {}, slope: {}, freeze: {}, name: {:?}, surface: {}, subsurface: {}, grass_color: {:?}, leaves_color: {:?}, water_color: {:?}, temperature: {:?}, humidity: {:?} }},", b.tree_density, tree_shape, b.tree_height, b.terrain, b.depth, resolve(&b.underwater), resolve(&b.slope), b.freeze, b.name, resolve(&b.surface), resolve(&b.subsurface), b.grass_color, b.leaves_color, b.water_color, b.temperature, b.humidity).unwrap();
    }
    out.push_str("];\n");
    fs::write(dest.join("biomes.rs"), out).unwrap();
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recipes {
    recipes: Vec<Recipe>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recipe {
    pattern: Option<Vec<String>>,
    key: Option<std::collections::BTreeMap<String, String>>,
    ingredients: Option<Vec<String>>,
    result: RecipeResult,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipeResult {
    item: String,
    count: u8,
}
fn generate_recipes(root: &Path, dest: &Path, items: &[Item]) {
    let recipes: Recipes = read(&root.join("recipes.toml"));
    let resolve = |name: &str| {
        items
            .iter()
            .find(|i| i.name == name)
            .unwrap_or_else(|| panic!("recipes.toml: unknown item {name}"))
    };
    let mut seen = BTreeSet::new();
    let mut out = String::from("pub static RECIPES: &[Recipe] = &[\n");
    for recipe in recipes.recipes {
        let result = resolve(&recipe.result.item);
        assert!(
            (1..=result.max_stack).contains(&recipe.result.count),
            "recipes.toml: invalid result count"
        );
        let (width, height, mut cells) = if let Some(pattern) = recipe.pattern {
            assert!(
                recipe.ingredients.is_none(),
                "recipes.toml: mixed recipe kinds"
            );
            assert!(
                (1..=3).contains(&pattern.len()),
                "recipes.toml: pattern height"
            );
            let width = pattern[0].chars().count();
            assert!((1..=3).contains(&width), "recipes.toml: pattern width");
            let key = recipe.key.expect("recipes.toml: missing key");
            for (ch, name) in &key {
                assert!(
                    ch.chars().count() == 1 && ch != " ",
                    "recipes.toml: invalid key"
                );
                resolve(name);
            }
            let mut used = BTreeSet::new();
            let mut cells = Vec::new();
            for row in &pattern {
                assert_eq!(
                    row.chars().count(),
                    width,
                    "recipes.toml: unequal row lengths"
                );
                for ch in row.chars() {
                    cells.push(if ch == ' ' {
                        0
                    } else {
                        let ch = ch.to_string();
                        used.insert(ch.clone());
                        resolve(
                            key.get(&ch)
                                .expect("recipes.toml: character missing from key"),
                        )
                        .id
                    });
                }
            }
            assert_eq!(used.len(), key.len(), "recipes.toml: unused key");
            assert!(cells.iter().any(|&i| i != 0), "recipes.toml: empty pattern");
            // Canonical bounding rectangle also detects duplicates with outer padding.
            let xs: Vec<_> = (0..width)
                .filter(|&x| (0..pattern.len()).any(|y| cells[y * width + x] != 0))
                .collect();
            let ys: Vec<_> = (0..pattern.len())
                .filter(|&y| (0..width).any(|x| cells[y * width + x] != 0))
                .collect();
            let (left, right, top, bottom) = (xs[0], xs[xs.len() - 1], ys[0], ys[ys.len() - 1]);
            let cropped = (top..=bottom)
                .flat_map(|y| (left..=right).map(move |x| (y, x)))
                .map(|(y, x)| cells[y * width + x])
                .collect();
            (right - left + 1, bottom - top + 1, cropped)
        } else {
            assert!(recipe.key.is_none(), "recipes.toml: shapeless key");
            let ingredients = recipe
                .ingredients
                .expect("recipes.toml: missing ingredients");
            assert!(
                (1..=9).contains(&ingredients.len()),
                "recipes.toml: ingredients length"
            );
            (
                0,
                0,
                ingredients
                    .iter()
                    .map(|i| resolve(i).id)
                    .collect::<Vec<_>>(),
            )
        };
        if width == 0 {
            cells.sort_unstable();
        }
        assert!(
            seen.insert((width, height, cells.clone())),
            "recipes.toml: duplicate recipe"
        );
        writeln!(out,"Recipe {{ width: {width}, height: {height}, ingredients: &{cells:?}, item: {}, count: {} }},", result.id, recipe.result.count).unwrap();
    }
    out.push_str("];\n");
    fs::write(dest.join("recipes.rs"), out).unwrap();
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Smelting {
    smelting: Vec<Smelt>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Smelt {
    input: String,
    output: String,
}
fn generate_smelting(root: &Path, dest: &Path, items: &[Item]) {
    let data: Smelting = read(&root.join("smelting.toml"));
    let mut seen = BTreeSet::new();
    let mut out = String::from("pub const RECIPES: &[(u16,u16)] = &[\n");
    for r in data.smelting {
        let resolve = |name: &str| {
            items
                .iter()
                .find(|i| i.name == name)
                .unwrap_or_else(|| panic!("smelting.toml: unknown item {name}"))
                .id
        };
        let input = resolve(&r.input);
        let output = resolve(&r.output);
        assert!(seen.insert(input), "smelting.toml: duplicate input");
        writeln!(out, "({input}, {output}),").unwrap();
    }
    out.push_str("];\n");
    fs::write(dest.join("smelting.rs"), out).unwrap();
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LootTable {
    loot: Vec<LootEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LootEntry {
    mob: String,
    item: String,
    min: u8,
    max: u8,
}

fn generate_loot(root: &Path, out: &mut String, items: &[Item]) {
    let data: LootTable = read(&root.join("loot.toml"));
    const MOB_NAMES: &[&str] = &["cow", "pig", "chicken"];
    let mut loot = vec![Vec::new(); MOB_NAMES.len()];
    for entry in data.loot {
        let kind = MOB_NAMES
            .iter()
            .position(|&name| name == entry.mob)
            .unwrap_or_else(|| panic!("loot.toml: unknown mob {}", entry.mob));
        let item = items
            .iter()
            .find(|item| item.name == entry.item)
            .unwrap_or_else(|| panic!("loot.toml: unknown item {}", entry.item));
        assert!(entry.min <= entry.max, "loot.toml: min must be <= max");
        loot[kind].push((item.id, entry.min, entry.max));
    }
    for (name, entries) in MOB_NAMES.iter().zip(loot) {
        let name = name.to_ascii_uppercase();
        writeln!(
            out,
            "pub const {name}_LOOT: &[(u16, u8, u8)] = &{entries:?};"
        )
        .unwrap();
    }
}
