"""The chosen map footprint, shared by terrain solids, color parts and add-ons."""

import manifold3d as mf
import numpy as np
from shapely.geometry import Polygon, box

SEGMENTS = 128


def footprint_polygon(bounds, width, height):
    if bounds.shape == "rectangle":
        return box(-width/2, -height/2, width/2, height/2)
    angles = np.linspace(0, 2*np.pi, SEGMENTS, endpoint=False)
    return Polygon(np.column_stack((width/2*np.cos(angles), height/2*np.sin(angles))))


def footprint_prism(bounds, width, height, bottom, top):
    polygon = footprint_polygon(bounds, width, height)
    return mf.CrossSection([np.asarray(polygon.exterior.coords[:-1])]).extrude(top-bottom).translate((0, 0, bottom))


def clip_footprint(vertices, faces, bounds, width, height):
    if bounds.shape == "rectangle":
        return vertices, faces
    solid = mf.Manifold(mf.Mesh64(np.asarray(vertices, dtype=np.float64), np.asarray(faces, dtype=np.uint64)))
    prism = footprint_prism(bounds, width, height, float(vertices[:, 2].min())-1, float(vertices[:, 2].max())+1)
    clipped = solid ^ prism
    if clipped.status() != mf.Error.NoError or clipped.is_empty():
        raise ValueError("The terrain could not form a closed selection shape. Try generating it again.")
    mesh = clipped.to_mesh64()
    return np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts, dtype=np.uint32)


def clip_color_parts(parts, bounds, width, height):
    if bounds.shape == "rectangle":
        return parts
    result = []
    for part in parts:
        vertices, faces = part["vertices"], part["faces"]
        solid = mf.Manifold(mf.Mesh64(np.asarray(vertices, dtype=np.float64), np.asarray(faces, dtype=np.uint64)))
        prism = footprint_prism(bounds, width, height, float(vertices[:, 2].min())-1, float(vertices[:, 2].max())+1)
        clipped = solid ^ prism
        if clipped.status() != mf.Error.NoError:
            raise ValueError("A color part could not be clipped to the selection shape.")
        if clipped.is_empty():
            continue
        mesh = clipped.to_mesh64()
        result.append(part | {"vertices": np.asarray(mesh.vert_properties)[:, :3], "faces": np.asarray(mesh.tri_verts), "solid": clipped})
    return result
