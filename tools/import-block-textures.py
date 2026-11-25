"""Import registered block faces from an extracted Bedrock Samples v1.26.60.5 resource_pack.

Usage: python tools/import-block-textures.py /path/to/resource_pack
Requires Python 3.11+ and Pillow only when refreshing the checked-in atlas.
"""
from pathlib import Path
import sys
import tomllib

from PIL import Image

from bedrock_tiles import pack, write_atlas

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "grass_block_top": "grass_top", "grass_block_side": "grass_side.tga",
    "oak_planks": "planks_oak", "oak_log": "log_oak", "oak_log_top": "log_oak_top",
    "bricks": "brick", "lamp_block": "redstone_lamp_on", "oak_leaves": "leaves_oak.tga",
    "oak_leaves_dense": "leaves_oak_opaque",
    "red_flower": "flower_rose", "yellow_flower": "flower_dandelion",
    "short_grass": "tallgrass.tga", "snow_block": "snow", "sandstone": "sandstone_normal",
    "crafting_table_bottom": "planks_oak", "furnace_front": "furnace_front_off",
    "farmland_moist": "farmland_wet", "white_wool": "wool_colored_white", "torch": "torch_on",
    "wheat_sprout": "wheat_stage_0", "wheat_shoot": "wheat_stage_2",
    "wheat_green": "wheat_stage_5", "wheat_ripe": "wheat_stage_7",
    "water": "water_still_grey", "water_flow": "water_flow_grey", "lava": "lava_still",
}


def source_file(name):
    source = SOURCES.get(name, name)
    return source if "." in source else source + ".png"


def main(resource_pack):
    with (ROOT / "data/registry/blocks.toml").open("rb") as file:
        names = tomllib.load(file)["textures"]
    atlas = {}
    for name in names:
        with Image.open(resource_pack / "textures/blocks" / source_file(name)) as image:
            strip = image.convert("RGBA")
        size = strip.width
        count = {"water": 32, "water_flow": 32, "lava": 32, "lava_flow": 16}.get(name, 1)
        if strip.height != size * count or size != (32 if name in ("water_flow", "lava_flow") else 16):
            raise ValueError(f"Unexpected frame size or count for {name}: {strip.size}")
        frames = []
        for frame in range(count):
            # The flowing tile repeats in both axes. Sample the middle 16×16 region at native scale.
            offset = (size - 16) // 2
            y = frame * size + offset
            frames.append(pack(strip.crop((offset, y, offset + 16, y + 16))))
        atlas[name] = frames
    path = ROOT / "apps/web/src/client/vanilla/block-tiles.json"
    write_atlas(path, atlas)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
