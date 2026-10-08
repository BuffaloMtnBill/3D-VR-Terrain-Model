"""Build the marker platform for brass nails in Blender.

Run with Blender 4.2 or newer (no GUI needed):

    blender --background --python scripts/make_marker_platform.py

It writes terrain_app/data/templates/marker-platform.{stl,blend,json}. Every size is a
millimeter parameter below; the JSON records them so the app can size the matching nail
hole and place a printed-on feature on the deck.

The platform turns the nail into a post: a flat deck that holds a little building or a
patch of terrain standing above the base map. Its hub takes the nail exactly like the
marker ball: a T-shaped slot captures the head, the shank leaves through the bottom of the
hub, and a slightly narrower slot mouth snaps the shank in place. The slot opens sideways
through the hub only, so the deck above it stays solid.

Coordinates: the hub bottom is at z = 0, the deck on top, centered on x/y.
"""
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Matrix

# The nail and its clearances must match scripts/make_marker_ball.py (same nails, same holes).
NAIL_SHANK_DIAMETER = 1.66
NAIL_LENGTH = 31.8  # overall, head included
# Assumed brass escutcheon-pin head; measure yours and adjust.
NAIL_HEAD_DIAMETER = 3.2
NAIL_HEAD_THICKNESS = 0.8
SHANK_CLEARANCE = 0.10  # diametral, for the slot that guides the shank
HEAD_CLEARANCE = 0.25  # diametral, for the head pocket
HEAD_VERTICAL_CLEARANCE = 0.20
SNAP_WIDTH = 1.46  # the slot mouth: 0.1 mm interference per side
SNAP_LENGTH = 0.6

DECK_SHAPE = "round"  # or "square"
DECK_SIZE = 30.0  # diameter of a round deck, side of a square one
DECK_THICKNESS = 2.4
DECK_CHAMFER = 0.6  # on the top edge
HUB_TOP_DIAMETER = 8.0
HUB_BOTTOM_DIAMETER = 5.5
SHANK_GUIDE = 4.4  # length of shank channel below the head pocket
HEAD_CAP = 1.2  # hub material between the head pocket and the deck
SEGMENTS = 96

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "terrain_app" / "data" / "templates"


def mesh_object(name, build):
    mesh = bpy.data.meshes.new(name)
    shape = bmesh.new()
    build(shape)
    shape.to_mesh(mesh)
    shape.free()
    item = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(item)
    return item


def box(name, x0, x1, y0, y1, z0, z1):
    def build(shape):
        bmesh.ops.create_cube(shape, size=1)
        bmesh.ops.scale(shape, vec=(x1-x0, y1-y0, z1-z0), verts=shape.verts)
        bmesh.ops.translate(shape, vec=((x0+x1)/2, (y0+y1)/2, (z0+z1)/2), verts=shape.verts)
    return mesh_object(name, build)


def cylinder(name, radius, z0, z1, top_radius=None, segments=SEGMENTS):
    def build(shape):
        bmesh.ops.create_cone(shape, cap_ends=True, segments=segments, radius1=radius,
                              radius2=radius if top_radius is None else top_radius, depth=z1-z0)
        if segments == 4:  # a square frustum with its sides along x and y
            bmesh.ops.rotate(shape, verts=shape.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi/4, 3, "Z"))
        bmesh.ops.translate(shape, vec=(0, 0, (z0+z1)/2), verts=shape.verts)
    return mesh_object(name, build)


def combine(target, tool, operation):
    modifier = target.modifiers.new(tool.name, "BOOLEAN")
    modifier.operation, modifier.object, modifier.solver = operation, tool, "EXACT"
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(tool)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    shank = NAIL_SHANK_DIAMETER+SHANK_CLEARANCE
    head = NAIL_HEAD_DIAMETER+HEAD_CLEARANCE
    head_bottom = SHANK_GUIDE
    head_top = head_bottom+NAIL_HEAD_THICKNESS+HEAD_VERTICAL_CLEARANCE
    hub_top = head_top+HEAD_CAP
    deck_top = hub_top+DECK_THICKNESS
    bottom_radius, top_radius = HUB_BOTTOM_DIAMETER/2, HUB_TOP_DIAMETER/2

    def hub_radius(z):
        return bottom_radius+(top_radius-bottom_radius)*z/hub_top

    # Deck: a slab with a chamfered top edge; the hub reaches 0.01 mm into it so the union is clean.
    if DECK_SHAPE == "round":
        radius, segments = DECK_SIZE/2, SEGMENTS
        inset = DECK_CHAMFER
    elif DECK_SHAPE == "square":
        radius, segments = DECK_SIZE/math.sqrt(2), 4
        inset = DECK_CHAMFER*math.sqrt(2)
    else:
        raise ValueError("DECK_SHAPE must be round or square.")
    platform = cylinder("Marker platform", radius, hub_top, deck_top-DECK_CHAMFER, segments=segments)
    combine(platform, cylinder("Deck chamfer", radius, deck_top-DECK_CHAMFER-.01, deck_top, radius-inset, segments=segments), "UNION")
    combine(platform, cylinder("Hub", bottom_radius, 0, hub_top+.01, hub_radius(hub_top+.01)), "UNION")

    outside = top_radius+1
    # Head pocket: round at the center, open to the +X side through the hub for sliding the nail in.
    combine(platform, cylinder("Head pocket", head/2, head_bottom, head_top), "DIFFERENCE")
    combine(platform, box("Head slot", 0, outside, -head/2, head/2, head_bottom, head_top), "DIFFERENCE")
    # Shank channel down through the hub; its slot narrows to the snap width for the last
    # SNAP_LENGTH before the tapered wall, all the way up the channel.
    channel_top = head_bottom+.01
    combine(platform, cylinder("Shank channel", shank/2, -1, channel_top), "DIFFERENCE")
    slot = box("Shank slot", 0, outside, -shank/2, shank/2, -1, channel_top)
    inner = cylinder("Snap inner wall", hub_radius(-1)-SNAP_LENGTH, -1, channel_top, hub_radius(channel_top)-SNAP_LENGTH)
    combine(slot, inner, "INTERSECT")
    combine(platform, slot, "DIFFERENCE")
    combine(platform, box("Snap mouth", 0, outside, -SNAP_WIDTH/2, SNAP_WIDTH/2, -1, channel_top), "DIFFERENCE")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    platform.select_set(True)
    bpy.ops.wm.stl_export(filepath=str(OUTPUT/"marker-platform.stl"), export_selected_objects=True, apply_modifiers=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT/"marker-platform.blend"), compress=True)
    nail_top = head_bottom+HEAD_VERTICAL_CLEARANCE/2+NAIL_HEAD_THICKNESS
    metadata = {
        "name": "Nail marker platform", "units": "mm", "generator": f"Blender {bpy.app.version_string}",
        "nail": {"shank_diameter": NAIL_SHANK_DIAMETER, "length": NAIL_LENGTH, "head_diameter": NAIL_HEAD_DIAMETER,
                 "head_thickness": NAIL_HEAD_THICKNESS, "head_size_assumed": True},
        "deck_shape": DECK_SHAPE, "deck_size": DECK_SIZE, "deck_thickness": DECK_THICKNESS, "deck_chamfer": DECK_CHAMFER,
        "hub_top_diameter": HUB_TOP_DIAMETER, "hub_bottom_diameter": HUB_BOTTOM_DIAMETER, "hub_height": round(hub_top, 2),
        # The mounting surface, above the hub's bottom; a printed-on feature starts here.
        "deck_top_z": round(deck_top, 2), "height": round(deck_top, 2),
        # Below the hub's bottom; the matching terrain hole must be at least this deep to seat it.
        "exposed_nail_length": round(NAIL_LENGTH-nail_top, 2),
        "recommended_hole_diameter": round(NAIL_SHANK_DIAMETER+.14, 2),
        "print_orientation": "deck down",
        "print": "Deck top down on the bed, no supports (the head-pocket bridge is 3.5 mm). Slide the nail in from the slot side "
                 "until it snaps; add a drop of CA glue. A platform with a printed-on top prints upright and needs supports under the deck.",
    }
    (OUTPUT/"marker-platform.json").write_text(json.dumps(metadata, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(metadata))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
