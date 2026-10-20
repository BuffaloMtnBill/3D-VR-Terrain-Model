"""Elevation profiles beyond a straight slice: a ridgeline between two points and the skyline seen from a viewpoint.

Points arrive as latitude/longitude, so they stay on the ground when the frame moves; both profiles use the
generated terrain's true elevations and see only the terrain inside its frame.
"""
import math

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import breadth_first_order, dijkstra, minimum_spanning_tree

from .features import to_selection

EARTH_RADIUS_M = 6371008.8
REFRACTION = .13  # standard atmospheric refraction coefficient: light bends to see ~7% farther over the curve
HIGH_GROUND = 8.0  # how strongly the ridgeline prefers high ground over a shorter way
SKYLINE_RADIUS_M = 1000.0  # skylines are drawn on a cylinder of this radius, so angles become lengths in meters


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def location(value, name):
    """A [latitude, longitude] pair, validated."""
    if (not isinstance(value, (list, tuple)) or len(value) != 2 or not all(finite(item) for item in value)
            or not -85.05112878 <= value[0] <= 85.05112878 or not -180 <= value[1] <= 180):
        raise ValueError(f"Choose the {name} on the map.")
    return float(value[0]), float(value[1])


def frame_point(terrain, point, name):
    """Frame coordinates (u right, v down, 0–1) of a latitude/longitude point; it must lie inside the frame."""
    uv = to_selection(terrain.bounds, [[point[1], point[0]]])[0]
    if not ((uv > -1e-6) & (uv < 1+1e-6)).all():
        raise ValueError(f"The {name} is outside the generated area. Move it inside the frame, or frame it and generate again.")
    return np.clip(uv, 0, 1)


def sample(grid, uv):
    """Bilinear heights at frame coordinates."""
    rows, columns = grid.shape
    x, y = np.clip(uv[..., 0], 0, 1)*(columns-1), np.clip(uv[..., 1], 0, 1)*(rows-1)
    x0, y0 = np.minimum(np.floor(x).astype(int), columns-2), np.minimum(np.floor(y).astype(int), rows-2)
    fx, fy = x-x0, y-y0
    return (grid[y0, x0]*(1-fx)+grid[y0, x0+1]*fx)*(1-fy)+(grid[y0+1, x0]*(1-fx)+grid[y0+1, x0+1]*fx)*fy


def grid_edges(rows, columns, width, height):
    """8-connected grid edges (i, j) with their lengths in meters."""
    index = np.arange(rows*columns).reshape(rows, columns)
    dx, dy = width/(columns-1), height/(rows-1)
    pairs = [(index[:, :-1], index[:, 1:], dx), (index[:-1, :], index[1:, :], dy),
             (index[:-1, :-1], index[1:, 1:], math.hypot(dx, dy)), (index[:-1, 1:], index[1:, :-1], math.hypot(dx, dy))]
    i = np.concatenate([a.ravel() for a, _, _ in pairs])
    j = np.concatenate([b.ravel() for _, b, _ in pairs])
    length = np.concatenate([np.full(a.size, step) for a, _, step in pairs])
    return i, j, length


def nearest_cell(uv, rows, columns):
    return int(round(uv[1]*(rows-1)))*columns+int(round(uv[0]*(columns-1)))


def ridgeline(terrain, start, end):
    """The highest way between two points and its profile.

    First the saddle: the highest elevation a path between the points can keep (the bottleneck of the maximum
    spanning tree). Then, among paths that never drop below that saddle, the shortest one weighted toward high ground,
    which follows the crest instead of contouring along a slope. Returns the path in frame coordinates, distances
    along it (m), elevations (m), its length (m), and the saddle elevation (m)."""
    a, b = frame_point(terrain, start, "first ridgeline point"), frame_point(terrain, end, "second ridgeline point")
    grid = terrain.elevations.astype(np.float64)
    rows, columns = grid.shape
    width, height = terrain.width, terrain.height
    if math.hypot((a[0]-b[0])*width, (a[1]-b[1])*height) < 2*max(width/(columns-1), height/(rows-1)):
        raise ValueError("Place the two ridgeline points farther apart.")
    flat = grid.ravel()
    i, j, length = grid_edges(rows, columns, width, height)
    count = rows*columns
    low = np.minimum(flat[i], flat[j])
    top = flat.max()
    # The maximum spanning tree on edge low points: the tree path between two cells keeps the highest possible minimum.
    tree = minimum_spanning_tree(coo_matrix((top-low+1e-3, (i, j)), shape=(count, count)).tocsr())
    source, target = nearest_cell(a, rows, columns), nearest_cell(b, rows, columns)
    _, parents = breadth_first_order(tree, source, directed=False, return_predecessors=True)
    saddle, cell = flat[target], target
    while cell != source and cell >= 0:
        saddle, cell = min(saddle, flat[cell]), parents[cell]
    saddle = min(saddle, flat[source])
    keep = low >= saddle-1e-6
    span = max(top-saddle, 1.0)
    cost = length[keep]*(1+HIGH_GROUND*(top-(flat[i[keep]]+flat[j[keep]])/2)/span)
    graph = coo_matrix((cost, (i[keep], j[keep])), shape=(count, count)).tocsr()
    _, parents = dijkstra(graph, directed=False, indices=source, return_predecessors=True)
    if parents[target] < 0 and target != source:
        raise ValueError("No ridgeline connects these points inside the generated area.")
    cells, cell = [target], target
    while cell != source:
        cell = parents[cell]
        cells.append(cell)
    cells = np.asarray(cells[::-1])
    path = np.column_stack((cells % columns/(columns-1), cells//columns/(rows-1)))
    path[0], path[-1] = a, b  # grid cells in between, so the path never leaves the high ground it was found on
    meters = path*(width, height)
    along = np.concatenate(([0], np.cumsum(np.hypot(*np.diff(meters, axis=0).T))))
    step = min(width/(columns-1), height/(rows-1))/2
    distances = np.unique(np.concatenate((along, np.arange(0, along[-1], step))))
    dense = np.column_stack((np.interp(distances, along, path[:, 0]), np.interp(distances, along, path[:, 1])))
    return {"path": path, "distances": distances, "heights": sample(grid, dense), "length": float(along[-1]),
            "saddle": float(saddle)}


def bearing_direction(terrain, point, bearing):
    """A unit direction in frame meters (x right, y down) for a compass bearing from the point, whatever the frame's rotation."""
    lat, lon = point
    reach = 100.0
    angle = math.radians(bearing)
    ahead = [lon+math.degrees(reach*math.sin(angle)/(EARTH_RADIUS_M*math.cos(math.radians(lat)))),
             lat+math.degrees(reach*math.cos(angle)/EARTH_RADIUS_M)]
    a, b = to_selection(terrain.bounds, [[lon, lat], ahead])
    vector = (b-a)*(terrain.width, terrain.height)
    return vector/np.linalg.norm(vector)


def viewpoint(terrain, point, bearing=0.0, fov=120.0, eye_m=2.0, samples=None, min_radius_m=0.0, max_radius_m=0.0):
    """The skyline seen from a point: for each direction across the field of view, the highest elevation angle of the
    terrain inside the frame, with the earth's curvature and standard refraction applied. Terrain nearer than
    min_radius_m is left out, as if the foreground were cleared away; terrain farther than max_radius_m (0: none, out to
    the horizon) is cut off, so the skyline, bands, and ridges end there.

    Returns azimuths (compass degrees, left to right), skyline angles (degrees), the distance (m) of the terrain that
    forms the skyline, a per-step angle table for depth bands, the step distances, and the farthest distance seen."""
    start = frame_point(terrain, point, "viewpoint")
    grid = terrain.elevations.astype(np.float64)
    rows, columns = grid.shape
    width, height = terrain.width, terrain.height
    count = samples or int(min(1440, max(90, round(fov*4))))
    azimuths = bearing-fov/2+np.arange(count)*fov/max(count-1, 1)
    step = min(width/(columns-1), height/(rows-1))/2
    reach = math.hypot(width, height)
    distances = np.arange(1, int(reach/step)+1)*step
    origin = start*(width, height)
    directions = np.asarray([bearing_direction(terrain, point, azimuth) for azimuth in azimuths])
    positions = origin+directions[:, None, :]*distances[None, :, None]  # (azimuths, steps, 2) in frame meters
    uv = positions/(width, height)
    inside = ((uv >= 0) & (uv <= 1)).all(axis=2)
    eye = float(sample(grid, start))+eye_m
    drop = distances**2/(2*EARTH_RADIUS_M)*(1-REFRACTION)
    angles = np.degrees(np.arctan2(sample(grid, uv)-drop[None, :]-eye, distances[None, :]))
    angles[~inside] = -np.inf  # a viewpoint at the frame's edge simply sees no terrain in directions that leave it
    if not np.isfinite(angles).any():
        raise ValueError("The viewpoint must have terrain around it inside the generated area.")
    angles[:, distances < min_radius_m] = -np.inf
    if not np.isfinite(angles).any():
        raise ValueError("Nothing lies beyond the minimum distance inside the generated area. Lower it, or generate a larger area.")
    if max_radius_m:
        if max_radius_m <= min_radius_m:
            raise ValueError("The cutoff distance must be farther than the minimum distance.")
        angles[:, distances > max_radius_m] = -np.inf
        if not np.isfinite(angles).any():
            raise ValueError("Nothing lies within the cutoff distance. Raise it, or move the viewpoint.")
    horizon = angles.max(axis=1)
    farthest = float(distances[np.isfinite(angles).any(axis=0)].max())
    horizon = np.where(np.isfinite(horizon), horizon, -90.0)
    return {"azimuths": azimuths, "angles": horizon, "skyline_m": distances[angles.argmax(axis=1)],
            "table": angles, "steps": distances, "farthest": farthest, "min_radius_m": float(min_radius_m), "max_radius_m": float(max_radius_m or 0),
            "eye_m": eye, "start": start,
            "directions": directions}


def band(view, near, far):
    """The skyline formed only by terrain between two fractions of the farthest distance seen (degrees, −90 where
    the band holds no terrain in that direction): one layer of a layered view, nearest ridges first."""
    near_m, far_m = near*view["farthest"], far*view["farthest"]
    columns = (view["steps"] >= near_m) & (view["steps"] <= far_m+1e-9)
    if not columns.any():
        return np.full(len(view["azimuths"]), -90.0)
    angles = view["table"][:, columns].max(axis=1)
    return np.where(np.isfinite(angles), angles, -90.0)


RIDGE_RELIEF_M = 15.0  # a crest needs at least this much hidden dip behind it, so small bumps near the viewer don't count
RIDGE_GAP = .15  # separate ridgelines are at least ~16% farther than the one in front (log distance)


def crests(view, prominence=.25):
    """Visible ridge crests along each ray: points seen from the viewpoint with hidden ground right behind them, where
    the terrain drops below the crest before anything farther shows again, by at least `prominence` degrees and at
    least RIDGE_RELIEF_M meters at the crest's distance.
    Returns (azimuth index, step index) arrays."""
    seen = view["table"]
    nearer = np.maximum.accumulate(np.concatenate((np.full((len(seen), 1), -np.inf), seen[:, :-1]), axis=1), axis=1)
    visible = np.isfinite(seen) & (seen >= nearer)
    rays, steps = np.nonzero(visible[:, :-1] & ~visible[:, 1:] & np.isfinite(seen[:, 1:]))
    keep = []
    for ray, step in zip(rays, steps):
        # The hidden stretch behind the crest, up to where the terrain shows again.
        behind = seen[ray, step+1:]
        again = np.flatnonzero(behind >= seen[ray, step])
        stretch = behind[:again[0]] if len(again) else behind
        stretch = stretch[np.isfinite(stretch)]
        needed = max(prominence, math.degrees(math.atan(RIDGE_RELIEF_M/view["steps"][step])))
        keep.append(len(stretch) >= 2 and seen[ray, step]-stretch.min() >= needed)
    keep = np.asarray(keep, dtype=bool)
    return rays[keep], steps[keep]


def ridges(view, count, prominence=.25):
    """The `count` strongest ridgelines in view (fewer when fewer stand apart), nearest first.

    Crests from every direction are grouped by distance (k-means on log distance, so near and far ridges separate
    alike). Each ridgeline's skyline is, per direction, the highest terrain after the nearer ridge's crest up to its
    own crest there, or up to the midpoint between the groups where that ray has no crest of the ridge. Returns
    [{distance_m, near_m, far_m, angles (degrees, −90 where nothing), coverage (share of directions with a crest)}]."""
    rays, steps = crests(view, prominence)
    if not len(rays):
        raise ValueError("No separate ridges are visible from this viewpoint. Move it, lower the minimum distance, or face toward the mountains.")
    distances = view["steps"]
    logs = np.log(distances[steps])
    count = max(1, min(count, len(np.unique(np.round(logs, 2)))))
    while True:
        centers = np.quantile(logs, (np.arange(count)+.5)/count)
        for _ in range(30):
            group = np.abs(logs[:, None]-centers[None, :]).argmin(axis=1)
            moved = np.asarray([logs[group == index].mean() if (group == index).any() else centers[index] for index in range(count)])
            if np.allclose(moved, centers):
                break
            centers = np.sort(moved)
        group = np.abs(logs[:, None]-centers[None, :]).argmin(axis=1)
        # One ridge seen at varying distances across the view is not two: groups must stand RIDGE_GAP apart, each with crests.
        if count == 1 or (np.diff(centers).min() >= RIDGE_GAP and len(np.unique(group)) == count):
            break
        count -= 1
    middles = np.exp((centers[:-1]+centers[1:])/2)
    table, total = view["table"], len(view["azimuths"])
    # Per ray, the far end of each ridge's stretch: its farthest crest in the group there, else the midpoint.
    ends = np.tile(np.append(middles, np.inf), (total, 1))
    found = np.zeros((total, count), dtype=bool)
    for ray, step, index in zip(rays, steps, group):
        if not found[ray, index] or distances[step] > ends[ray, index]:
            ends[ray, index] = distances[step]
        found[ray, index] = True
    result = []
    for index in range(count):
        starts = behind_crests(table, distances, ends[:, index-1], found[:, index-1]) if index else np.zeros(total)
        angles, visible = np.full(total, -90.0), np.zeros(total, dtype=bool)
        for ray in range(total):
            values = table[ray, (distances > starts[ray]) & (distances <= ends[ray, index])]
            values = values[np.isfinite(values)]
            if len(values):
                angles[ray] = values.max()
                # Seen only where nothing nearer stands higher in that direction.
                nearer = table[ray, distances <= starts[ray]]
                nearer = nearer[np.isfinite(nearer)]
                visible[ray] = not len(nearer) or angles[ray] >= nearer.max()
        result.append({"distance_m": float(np.exp(centers[index])), "near_m": float(middles[index-1]) if index else view["min_radius_m"],
                       "far_m": float(middles[index]) if index < count-1 else float(view["farthest"]),
                       "angles": angles, "visible": visible, "coverage": float(found[:, index].mean()),
                       "crest_m": np.where(found[:, index], ends[:, index], np.nan)})
    return result


def behind_crests(table, distances, crests, real, prominence=.25):
    """Per direction, where the ridge behind a nearer one begins: at the foot of the hidden ground behind the nearer
    crest, the low point before the terrain rises again (by at least the crest's own prominence), so the farther ridge
    doesn't start with that crest's back slope (hidden, but nearly as high as the crest). With no rise behind the crest
    the farther ridge has nothing there (infinity). Where the nearer ridge has no crest, it begins where that stretch ends."""
    starts = np.array(crests, dtype=float)
    for ray in np.flatnonzero(real):
        step = int(np.searchsorted(distances, crests[ray]))
        lowest, low_at, rise = np.inf, None, False
        for at in range(step+1, len(distances)):
            angle = table[ray, at]
            if not np.isfinite(angle):
                continue
            if angle < lowest:
                lowest, low_at = angle, at
            elif angle-lowest >= max(prominence, math.degrees(math.atan(RIDGE_RELIEF_M/distances[at]))):
                rise = True
                break
        starts[ray] = distances[low_at] if rise else np.inf
    return starts


def crest_paths(view, ridge, terrain):
    """Where a ridgeline seen from the viewpoint runs on the ground: its crest in each direction that has one, in frame
    coordinates, split where directions lack a crest or neighboring crests jump more than a quarter of their distance."""
    origin = view["start"]*(terrain.width, terrain.height)
    paths, current, previous = [], [], None
    for direction, distance in zip(view["directions"], ridge["crest_m"]):
        if not np.isfinite(distance) or (previous is not None and abs(distance-previous) > .25*min(distance, previous)):
            if len(current) >= 2:
                paths.append(current)
            current = []
        if np.isfinite(distance):
            current.append(np.round((origin+direction*distance)/(terrain.width, terrain.height), 6).tolist())
        previous = distance if np.isfinite(distance) else None
    if len(current) >= 2:
        paths.append(current)
    return paths


def skyline_profile(angles, fov):
    """A skyline as lengths on a cylinder: x along the arc and y = tan(angle), both in meters at SKYLINE_RADIUS_M, so
    a piece printed at true proportions looks like the view."""
    x = np.radians(np.linspace(0, fov, len(angles)))*SKYLINE_RADIUS_M
    y = np.tan(np.radians(np.clip(angles, -60, 60)))*SKYLINE_RADIUS_M
    return x, y, float(x[-1])


def view_ray_ends(view, terrain):
    """Frame coordinates of the field of view's edge rays where they leave the frame, or reach the cutoff distance (for
    drawing the wedge)."""
    ends = []
    for direction in (view["directions"][0], view["directions"][-1]):
        origin, best = view["start"]*(terrain.width, terrain.height), 0.0
        for distance in view["steps"]:
            uv = (origin+direction*distance)/(terrain.width, terrain.height)
            if not ((uv >= 0) & (uv <= 1)).all() or (view.get("max_radius_m") and distance > view["max_radius_m"]):
                break
            best = distance
        ends.append(((origin+direction*best)/(terrain.width, terrain.height)).tolist())
    return ends


def profile_options(value):
    """A validated profile request: {"mode": "ridgeline", "start", "end"} or {"mode": "viewpoint", "point",
    "bearing", "fov", "eye_m", "bands"}; points are [latitude, longitude]."""
    if not isinstance(value, dict) or value.get("mode") not in ("ridgeline", "viewpoint"):
        raise ValueError("Choose ridgeline or viewpoint as the profile type.")
    if value["mode"] == "ridgeline":
        return {"mode": "ridgeline", "start": location(value.get("start"), "first ridgeline point"),
                "end": location(value.get("end"), "second ridgeline point")}
    result = {"mode": "viewpoint", "point": location(value.get("point"), "viewpoint")}
    for name, default, low, high, message in (
            ("min_radius_m", 0.0, 0, 50000, "The minimum distance must be between 0 and 50,000 meters."),
            ("max_radius_m", 0.0, 0, 500000, "The cutoff distance must be between 0 (the horizon) and 500,000 meters."),
            ("bearing", 0.0, 0, 360, "The view direction must be a compass bearing from 0 to 360 degrees."),
            ("fov", 120.0, 10, 360, "The field of view must be between 10 and 360 degrees."),
            ("eye_m", 2.0, 0, 500, "The eye height must be between 0 and 500 meters above the ground.")):
        number = value.get(name, default)
        if not finite(number) or not low <= number <= high:
            raise ValueError(message)
        result[name] = float(number)
    result["ridges"] = value.get("ridges", False)
    if not isinstance(result["ridges"], bool):
        raise ValueError("Detect ridges must be true or false.")
    bands = value.get("bands", 1)
    if not finite(bands) or bands != int(bands) or not 1 <= bands <= (7 if result["ridges"] else 5):
        raise ValueError("Depth bands must be a whole number from 1 to 5, or 1 to 7 detected ridges.")
    result["bands"] = int(bands)
    return result


def band_edges(count):
    """Distance-band edges as fractions of the farthest distance seen; nearer bands are narrower, as in a real view."""
    return [0.0]+[(index/count)**2 for index in range(1, count+1)]


def profile_json(terrain, request):
    """The geography page's chart and overlays for a ridgeline or viewpoint profile."""
    if request["mode"] == "ridgeline":
        ridge = ridgeline(terrain, request["start"], request["end"])
        return {"mode": "ridgeline", "path": np.round(ridge["path"], 6).tolist(),
                "distances": np.round(ridge["distances"], 2).tolist(), "heights": np.round(ridge["heights"], 2).tolist(),
                "length_m": round(ridge["length"], 1),
                "highest_m": round(float(ridge["heights"].max()), 1), "lowest_m": round(float(ridge["heights"].min()), 1)}
    view = viewpoint(terrain, request["point"], request["bearing"], request["fov"], request["eye_m"], min_radius_m=request["min_radius_m"],
                     max_radius_m=request["max_radius_m"])
    edges, found = band_edges(request["bands"]), []
    if request["ridges"]:
        found = ridges(view, request["bands"])
        bands = [np.round(ridge["angles"], 3).tolist() for ridge in found]
    else:
        bands = [np.round(band(view, edges[index], edges[index+1]), 3).tolist() for index in range(request["bands"])] if request["bands"] > 1 else []
    return {"mode": "viewpoint", "min_radius_m": request["min_radius_m"], "max_radius_m": request["max_radius_m"],
            "ridges": [{**{key: round(ridge[key], 3 if key == "coverage" else 1) for key in ("distance_m", "near_m", "far_m", "coverage")},
                        "visible": ridge["visible"].tolist(), "paths": crest_paths(view, ridge, terrain)} for ridge in found], "azimuths": np.round(view["azimuths"], 3).tolist(), "angles": np.round(view["angles"], 3).tolist(),
            "skyline_m": np.round(view["skyline_m"], 1).tolist(), "bands": bands, "band_edges": edges,
            "farthest_m": round(view["farthest"], 1), "eye_elevation_m": round(view["eye_m"], 1),
            "point": np.round(view["start"], 6).tolist(), "rays": view_ray_ends(view, terrain),
            "bearing": request["bearing"], "fov": request["fov"]}
