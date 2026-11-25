"""Import the item atlas, mining stages and HUD from Bedrock Samples v1.26.60.5.

Usage: python tools/import-item-hud-textures.py /path/to/resource_pack
"""
import shutil
import sys
import tomllib
from pathlib import Path

from PIL import Image

from bedrock_tiles import pack, write_atlas

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "apps/web/src/client/vanilla"
ALIASES = {
    "bucket": "bucket_empty", "water_bucket": "bucket_water", "lava_bucket": "bucket_lava",
    "bow": "bow_standby", "wheat_seeds": "seeds_wheat",
}
UI = (
    "heart_background", "heart", "heart_half", "hunger_background", "hunger_full", "hunger_half",
    "bubble", "selected_hotbar_slot", "flame_empty_image", "flame_full_image", "arrow_inactive",
    "arrow_active", "filled_progress_bar", "empty_progress_bar",
)


def item_source(name):
    if name == "torch_item":
        return "blocks/torch_on.png"
    parts = name.split("_", 1)
    if parts[0] in ("raw", "cooked"):
        name = "_".join(reversed(parts))
    return "items/" + ALIASES.get(name, name.replace("wooden_", "wood_")) + ".png"


def tile(textures, path):
    with Image.open(textures / path) as image:
        if image.size != (16, 16):
            raise ValueError(f"Unexpected tile size for {path}: {image.size}")
        return pack(image.convert("RGBA"))


def main(resource_pack):
    textures = resource_pack / "textures"
    with (ROOT / "data/registry/items.toml").open("rb") as registry:
        keys = [item["texture"] for item in tomllib.load(registry)["items"] if "texture" in item]
    keys.extend(["leather", *(f"bow_pulling_{i}" for i in range(3))])
    write_atlas(OUT / "item-tiles.json", {name: tile(textures, item_source(name)) for name in keys})
    stages = [tile(textures, f"environment/destroy_stage_{i}.png") for i in range(10)]
    write_atlas(OUT / "mining-tiles.json", {"stages": stages})

    hud = OUT / "hud"
    hud.mkdir(exist_ok=True)
    for name in UI:
        shutil.copyfile(textures / "ui" / (name + ".png"), hud / (name + ".png"))
    with Image.open(textures / "gui/icons.png") as atlas:
        atlas.crop((3, 3, 12, 12)).save(hud / "crosshair.png")
    strip = Image.new("RGBA", (182, 22))
    x = 0
    for name in ["hotbar_start_cap", *(f"hotbar_{i}" for i in range(9)), "hotbar_end_cap"]:
        with Image.open(textures / "ui" / (name + ".png")) as image:
            strip.paste(image.convert("RGBA"), (x, 0))
            x += image.width
    strip.save(hud / "hotbar.png")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
