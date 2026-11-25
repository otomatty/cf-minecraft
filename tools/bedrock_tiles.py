"""Lossless storage for the 16×16 Bedrock tiles used by the client atlas."""
import base64
import json


def pack(tile):
    # Each frame has at most 256 colours. Preserve RGBA exactly, including transparent RGB.
    colors = dict.fromkeys(tile.getdata())
    indices = {color: i for i, color in enumerate(colors)}
    palette = bytes(channel for color in colors for channel in color)
    pixels = bytes(indices[color] for color in tile.getdata())
    return [base64.b64encode(value).decode("ascii") for value in (palette, pixels)]


def write_atlas(path, atlas):
    path.write_text("{\n" + ",\n".join(
        f'  "{name}": ' + json.dumps(frames, separators=(",", ":")) for name, frames in atlas.items()
    ) + "\n}\n")
