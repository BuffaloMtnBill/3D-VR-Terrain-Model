"""Build the push-pin marker ball for brass nails in Blender.

Run with Blender 4.2 or newer (no GUI needed):

    blender --background --python scripts/make_marker_ball.py

It writes terrain_app/data/templates/marker-ball.{stl,blend,json}. Every size is
a millimeter parameter below; the JSON records them so the app can size the
matching nail hole in the terrain.

The nail slides in from the side: a T-shaped slot captures the head inside the
ball, the shank leaves through the bottom collar, and a slightly narrower slot
mouth snaps the shank in place. A drop of CA glue makes it permanent.
"""
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy

NAIL_SHANK_DIAMETER = 1.66
NAIL_LENGTH = 31.8  # overall, head included
# Assumed brass escutcheon-pin head; measure yours and adjust.
NAIL_HEAD_DIAMETER = 3.2
NAIL_HEAD_THICKNESS = 0.8

BALL_DIAMETER = 10.0
BALL_CENTER_Z = 7.0
COLLAR_BOTTOM_DIAMETER = 4.4
COLLAR_TOP_Z = 3.6
SHANK_CLEARANCE = 0.10  # diametral, for the slot that guides the shank
HEAD_CLEARANCE = 0.25  # diametral, for the head pocket
HEAD_VERTICAL_CLEARANCE = 0.20
SNAP_WIDTH = 1.46  # the slot mouth: 0.1 mm interference per side
SNAP_LENGTH = 0.6
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


def cylinder(name, radius, z0, z1, top_radius=None):
    def build(shape):
        bmesh.ops.create_cone(shape, cap_ends=True, segments=SEGMENTS, radius1=radius,
                              radius2=radius if top_radius is None else top_radius, depth=z1-z0)
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
    radius = BALL_DIAMETER/2

    def sphere(shape):
        bmesh.ops.create_uvsphere(shape, u_segments=SEGMENTS, v_segments=SEGMENTS//2, radius=radius)
        bmesh.ops.translate(shape, vec=(0, 0, BALL_CENTER_Z), verts=shape.verts)
    ball = mesh_object("Marker ball", sphere)
    # A tapered collar gives a flat printing face and supports the shank.
    collar_top_radius = math.sqrt(radius**2-(BALL_CENTER_Z-COLLAR_TOP_Z)**2)-.05
    combine(ball, cylinder("Collar", COLLAR_BOTTOM_DIAMETER/2, 0, COLLAR_TOP_Z, collar_top_radius), "UNION")

    shank = NAIL_SHANK_DIAMETER+SHANK_CLEARANCE
    head = NAIL_HEAD_DIAMETER+HEAD_CLEARANCE
    head_bottom = BALL_CENTER_Z-NAIL_HEAD_THICKNESS/2-HEAD_VERTICAL_CLEARANCE/2
    head_top = head_bottom+NAIL_HEAD_THICKNESS+HEAD_VERTICAL_CLEARANCE
    outside = radius+1
    # Head pocket: round at the center, open to the +X side for sliding the nail in.
    combine(ball, cylinder("Head pocket", head/2, head_bottom, head_top), "DIFFERENCE")
    combine(ball, box("Head slot", 0, outside, -head/2, head/2, head_bottom, head_top), "DIFFERENCE")
    # Shank channel down through the collar, narrowed at its mouth to snap the nail in.
    combine(ball, cylinder("Shank channel", shank/2, -1, head_bottom+.01), "DIFFERENCE")
    mouth = COLLAR_BOTTOM_DIAMETER/2
    combine(ball, box("Shank slot", 0, mouth-SNAP_LENGTH, -shank/2, shank/2, -1, head_bottom+.01), "DIFFERENCE")
    combine(ball, box("Snap mouth", mouth-SNAP_LENGTH-.01, outside, -SNAP_WIDTH/2, SNAP_WIDTH/2, -1, head_bottom+.01), "DIFFERENCE")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    ball.select_set(True)
    bpy.ops.wm.stl_export(filepath=str(OUTPUT/"marker-ball.stl"), export_selected_objects=True, apply_modifiers=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT/"marker-ball.blend"), compress=True)
    nail_top = head_bottom+HEAD_VERTICAL_CLEARANCE/2+NAIL_HEAD_THICKNESS
    metadata = {
        "name": "Push-pin marker ball", "units": "mm", "generator": f"Blender {bpy.app.version_string}",
        "nail": {"shank_diameter": NAIL_SHANK_DIAMETER, "length": NAIL_LENGTH, "head_diameter": NAIL_HEAD_DIAMETER,
                 "head_thickness": NAIL_HEAD_THICKNESS, "head_size_assumed": True},
        "ball_diameter": BALL_DIAMETER, "height": BALL_CENTER_Z+radius, "collar_bottom_diameter": COLLAR_BOTTOM_DIAMETER,
        # Below the ball's flat bottom; the matching terrain hole must be at least this deep to seat it.
        "exposed_nail_length": round(NAIL_LENGTH-nail_top, 2),
        "recommended_hole_diameter": round(NAIL_SHANK_DIAMETER+.14, 2),
        "print": "Flat collar down, no supports. Slide the nail in from the slot side until it snaps; add a drop of CA glue.",
    }
    (OUTPUT/"marker-ball.json").write_text(json.dumps(metadata, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(metadata))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
