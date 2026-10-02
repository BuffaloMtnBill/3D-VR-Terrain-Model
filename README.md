# Terrain Studio · 3D Map Extractor

A Python application that turns a rectangle on OpenStreetMap into an interactive
3D terrain model. A fixed, resizable frame selects the map area beneath it.
Runs locally in your browser, with no API key required.
The dark theme uses forest green, brown, and tan. The map opens with terrain and
contour lines; the map-style selector also offers a street map.

## Run

Requires Python 3.11 or newer and a modern browser with WebGL support.

```bash
cd /home/will/Projects/3D-Map-Extractor
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:8000**. Stop the server with Ctrl+C.
Use `python app.py --port 8080` to change the port, or `--open` to launch your
browser. You can also install with `pip install .` and run `terrain-studio`.

## Use

1. Pick a preset, **search for an address, city, or place name**, or enter a
   **US ZIP code** (five digits or ZIP+4). The search box zooms to fit the place
   it finds; typing a `latitude, longitude` pair there jumps straight to it.
   Search and ZIP navigation center the selected frame on the
   location while retaining its size, rotation, and aspect ratio. The selection frame
   stays fixed on screen while you pan the map beneath it. Zoom with the +/−
   buttons or mouse wheel to change the geographic area inside the frame. Buttons
   move in quarter-level steps; the wheel uses continuous fractional zoom with
   reduced sensitivity for precise framing.
2. Drag the **right border** or **bottom border** to resize along the frame's
   axes, keeping its opposite corner fixed. Drag the **lower-right corner** to
   rotate around the center without changing the width or height. Hold Shift
   to snap rotation to 15° increments. Focus the corner and use arrow keys for
   1° rotation (Shift: 15°); Home resets the angle. Edge handles also support
   arrow keys. Escape cancels a drag. **Reset frame** restores the default size
   and zero rotation. The **two-point alignment button** beside Reset frame
   enters a mode where you click two map locations. The box moves to their
   midpoint and rotates its horizontal axis through both, retaining its width
   and height. The first point is marked and a dashed guide follows the pointer.
   Escape or pressing the button again cancels without changing the box;
   selecting a preset, ratio, or resetting the frame also exits alignment mode. **Coordinates** sets the rectangle's boundaries before rotation
   and its clockwise angle.
   The **1:1**, **3:4**, and **16:9** map buttons snap its width-to-height ratio,
   preserving its center and rotation. The selected ratio is highlighted. Click
   it again to switch orientation: **3:4 ↔ 4:3** or **16:9 ↔ 9:16**. Square remains 1:1.
3. Choose an **Elevation source** (Mapzen worldwide, or USGS 3DEP for the United
   States) and a terrain detail level, then click **Generate terrain**. Downloads show
   progress; your previous model stays available while the new one is built.
4. Click **Edit** in the right-hand **Make it yours** status panel to adjust the
   style and geometry. Click **Done** to collapse it back to its current settings;
   Export model stays in the left sidebar. Orbit with the mouse, scroll to zoom, and
   use the camera reset or auto-rotate buttons. Under **Map features**, check
   roads, train tracks, water, or buildings. **Boundaries** opens a submenu for
   borders, city boundaries, and park boundaries; **Trails** opens one for the AT
   (Appalachian Trail) and other trails. Checking **Buildings** reveals a
   **3D buildings** option. Submenus appear only while their category is checked;
   unchecking the category hides all of its layers and keeps your choices.
   Each has its own color selector; changes apply immediately to loaded layers.
   Roads and Water also have detail sliders. Lower detail omits minor roads,
   creeks, and smaller water areas while retaining larger mapped features.
5. Move the cross-section slider to inspect profiles along the frame's axes
   (east–west or north–south at zero rotation). The section guide appears on
   the map only; the 3D preview stays clear.
   The orange line marks the section on both the map and model.
6. Export your landscape or save a PNG of the preview.

The default Roan Mountain terrain is a **real bundled DEM**, downloaded from
Mapzen Terrain Tiles. It renders without network access. New area extraction and
map tiles, place search, ZIP lookup, and feature layers require internet access. The UI libraries are bundled locally.
The Explore a place list includes Roan Mountain, Mount Rainier, Yosemite Valley,
Mount Fuji, Grand Canyon, and Chamonix.

## Controls

| Control | Effect |
| --- | --- |
| Alpine / Earth / Desert | Three elevation-based color palettes |
| Print | Mapped surface colors for four-filament printing; opens a six-surface color menu |
| Elevation multiplier | 1× preserves the horizontal-to-vertical ratio; values above 1× emphasize relief |
| Solid base | Connects the terrain rim to a flat bottom for a closed mesh |
| Base thickness | Percentage of the longest horizontal edge |
| Contour lines | Overlays elevation contours at an automatically chosen interval |
| Faceted surface | Uses flat shading to emphasize the triangular structure |
| Relief | Lit, colored 3D terrain |
| Map | Drapes the currently visible terrain or street map over the 3D surface |
| Wireframe | Shows terrain triangles |
| Elevation | Top-down elevation color map, in the selected frame's orientation |
| Profile | A movable geographic cross-section, showing unexaggerated elevations |
| Map features and colors | Optional OSM geometry draped over the terrain; railways have two rails and ties, boundaries use dashed lines, and water areas retain islands |

## Exports

Choose the **longest horizontal edge in millimeters** (default: 180 mm).
Geometry exports use the current multiplier and solid-base settings. The UI
uses the original elevations; the smoothing slider has been removed.

- **Four-color 3MF:** select Print, enable Solid base, and use at most four
  distinct colors across surfaces and enabled map features. Downloads a native `terrain-print.3mf` file with
  millimeter geometry, shared materials, and a multi-part assembly. Each color
  has a closed solid part; identical colors merge into one part. Open it in
  your slicer and assign each named part to its matching filament. These are
  generic 3MF models, without printer-specific profiles or slot assignments.
  Selected Roads, Train tracks, Borders, Water, City boundaries, Park boundaries,
  AT, and Buildings are included. Linework and water are colored inlays 0.6 mm
  deep; line widths are at least 0.6 mm (rail strokes 0.4 mm). Buildings have
  flat raised roofs using mapped heights/levels, with a minimum 0.8 mm rise;
  with 3D buildings on, mapped building parts and roof shapes are printed.
  Unchecked layers are omitted and Roads/Water detail settings are honored.
  Choose feature colors from your four surface colors, or share surface colors
  to free a filament slot. Same-color features merge with terrain; mesh booleans
  remove overlapping interiors between different color parts.
  Overlapping layers take precedence in this order: water, roads, train tracks,
  borders, cities, parks, other trails, AT, then buildings. Features follow the saved terrain's
  selection and rotation. Assign the color parts to filament slots in your slicer.
- **STL:** a direct `.stl` download. Millimeter coordinates; X selection right,
  Y selection top, Z up (X east and Y north at zero rotation).
  Closed meshes are suited
  to slicers; disable Solid base to export only the open terrain surface.
- **OBJ:** a direct `.obj` download with metadata and source credits in comments.
  Millimeter coordinates; X selection right, Y selection top, Z up. This export contains geometry.
- **GLB:** a self-contained colored model, with palette and source credits in
  glTF extras. Includes selected feature geometry and its chosen colors;
  water polygons include their self-contained transparency mask. Uses meters according to the glTF convention, X selection right,
  Y up, Z selection bottom;
  a 180 mm landscape has a 0.18 m longest horizontal edge. Map textures are omitted.
- **Preview image:** the camera button saves the rendered view, including selected
  map features, their colors, and source credits.
- **Heightmap PNG:** a direct 16-bit `.png` download. Bounds, min/max elevations,
  decoding instructions, and source credits are embedded in PNG text fields.
  Decode PNG values using
  `min_m + pixel / 65535 * (max_m - min_m)`.
- **Elevation CSV / NumPy:** separate `.csv` and `.npy` downloads of the original,
  unexaggerated elevation grid in meters. Row 0 is the selection's top edge;
  column 0 is its left edge (north and west at zero rotation).
- **Optional settings & coordinates (JSON):** download `terrain-metadata.json`
  separately if you want to retain geographic bounds, sampling information, and
  model settings. Models open and print without this file. CSV and NumPy grids
  benefit from it when reconstructing their geographic coordinates.
- **Source credits (TXT):** a separate `terrain-credits.txt` download, useful when
  sharing a model. OBJ, GLB, and PNG files include these credits inside the file.

Solid STL/OBJ meshes share connected vertices around the surface, walls, and
floor. Every export button downloads one native file. OBJ, GLB, and PNG embed
metadata; feature choices and colors are recorded in GLB, OBJ, PNG, and optional
JSON metadata. STL and OBJ contain terrain geometry; four-color 3MF contains solid terrain
parts and selected map features grouped by print color. GLB and preview images
include the visible map-feature layers. Optional JSON preserves settings,
selection rotation, four geographic
corners, and the absolute elevation used
as the model's zero-height reference. Retain source attribution when sharing.

## Elevation source and geographic limits

[OpenTopoMap](https://opentopomap.org/about) provides the default terrain map
with contour lines, using OpenStreetMap and SRTM data. The street-map option
uses OpenStreetMap's standard tiles. By default, heights come from the public
[Mapzen / Tilezen Terrain Tiles dataset on AWS](https://registry.opendata.aws/terrain-tiles/),
decoded from Terrarium PNG tiles. The program caches these tiles for 30 days in
`.cache/elevation/` under the directory where you launch it. At most 64 tiles are
used for a selection, with four simultaneous tile downloads. Local jobs are
limited to two simultaneous extractions and four outstanding jobs.

The **Elevation source** selector in the left sidebar switches between two DEMs;
the map in the finder box stays the same either way.

| Source | Coverage | Detail |
| --- | --- | --- |
| **Mapzen** (default) | Global, including ocean bathymetry | About 10 m in the US, about 30 m elsewhere |
| **USGS 3DEP** | United States and territories, land only | Lidar-derived, down to 1 m where surveyed; 10 m elsewhere |

USGS 3DEP heights come from The National Map's public
[3DEP elevation image service](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer),
which needs no API key and is public domain. Each selection is one request for a
Web Mercator raster at twice the grid density (never finer than 1 m, at most
1200 pixels per side), cached for 30 days in `.cache/3dep/`. The extra detail
shows on small selections: at 384 points, an area wider than about 4 km is
already sampled more coarsely than Mapzen's 10 m data. Selections outside the
United States, or reaching beyond the edge of its coverage, fail with a message
instead of filling gaps; use Mapzen there. 3DEP heights use NAVD88 in the
conterminous United States; no datum conversion is applied between sources.
The source of each model is shown below the profile and saved in export metadata.

- Select areas with each side between **50 m and 250 km**, within Web Mercator's
  latitude range of ±85.0511°. Date-line crossings are not supported.
- Grid detail is 96, 160, 256, or 384 points along the longest side. The shorter
  side preserves geographic aspect ratio, with a minimum of 16 samples.
- At zero rotation, terrain uses a regular latitude/longitude grid. Rotated
  selections use a rectangular grid in the map's Mercator plane, sampled inside
  the rotated box. Both use bilinear interpolation and pixel-center coordinates,
  including across tile seams. Metadata records the rotation, geographic corner
  coordinates, and enclosing geographic bounds.
- Horizontal dimensions use a local equirectangular approximation at the area
  center. This is practical for regional visualization; it is not a cadastral
  or survey projection. Heights retain the source's vertical reference.
- **Grid spacing is not survey accuracy.** Source detail and quality vary by
  region; increasing mesh resolution cannot recover detail absent from the DEM.
  Terrain represents the ground surface. Optional roads and boundaries are
  colored overlays; Buildings adds approximate structures from OSM footprints.
  Mapped heights take priority, followed by three meters per mapped level;
  missing heights use an illustrative six meters. Trees are not modeled.
- Failed downloads are reported explicitly; the app does not substitute fake
  terrain. Jobs/models are held in memory for up to an hour after last access,
  with up to twelve job records. Restarting the server discards generated models;
  downloaded tiles remain cached.

Map view reuses only map images already loaded for the current viewport; it does
not bulk-download map tiles or put map raster imagery in model exports. Browser
caching and visible attribution follow the
[OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
A provider must support CORS to use its tiles as a 3D texture.

## Place search, ZIP navigation, and map features

Address and place-name search uses OpenStreetMap data through the public
[Nominatim](https://nominatim.org/) service. Searches run when you submit the
box (there is no as-you-type lookup), return the best single match, are limited
to one request per second, and cache for 30 days in `.cache/places/`, following
the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).
Coverage and address precision depend on OSM.

US ZIP locations come from [Zippopotam.us](https://www.zippopotam.us/), using
GeoNames data. Leading zeros are preserved; ZIP+4 uses its five-digit area.
Locations are representative points for the ZIP area. Lookups cache for 30 days
in `.cache/zip/`. Click Generate terrain after navigating to create its model.

Features come from [OpenStreetMap](https://www.openstreetmap.org/copyright)
through the public Overpass API. One request fetches every category for the
current terrain; toggling layers or changing colors reuses that data. Feature
requests are limited to **50 km per side**, two simultaneous downloads, 20 MB of
response data, and 100,000 input points. Results cache for seven days in
`.cache/features/`. Rotated areas fetch their enclosing geographic extent, then
clip linework and polygons to the actual selected rectangle. Elevation exaggeration moves the overlays with the surface.

Borders represent OSM administrative levels 2–6 (country, state, and county);
city boundaries use levels 7–10. These categories have separate switches,
so disabling Borders leaves selected city or park boundaries intact. Definitions vary by country. Parks include
mapped parks, nature reserves, national parks, and protected areas. Water
includes mapped waterways and water areas. Coverage depends on OSM: missing
layers are reported as empty, and service failures offer a Retry button.
Buildings use OSM footprints, courtyards, and mapped height/level tags;
missing heights use an illustrative six meters. Layers are off by default
and are fetched when selected. This app is intended
for occasional local requests; use your own Overpass endpoint for larger usage.

Road detail uses OSM highway classes: 0% retains motorways, trunk roads, primary
roads and their links; 25% adds secondary roads, 50% tertiary roads, 75% residential
and unclassified roads, and 100% service roads, tracks, and other small roads.
Water detail retains rivers at every setting, adds canals from 25%, streams
from 80%, and ditches/drains at 100%. For water polygons, the minimum area drops
continuously from two hectares at 0% to zero at 100%. Area is measured from the
full mapped body before clipping, preserving large lakes when only a small
piece lies in the selection. Detail changes reuse loaded data and apply to both
preview and GLB export; the chosen percentages are saved in export metadata.

Every switch removes its generated layer from the preview and GLB. The Map
view's raster image can contain its own drawn-in roads and boundaries; feature
checkboxes control the added geometry. Relief and Print display generated
features without that raster imagery. The UI shows this distinction in Map view.

## Four-color Print palette

**Print** replaces Slate in the surface palettes. Selecting it opens a menu for
Dark foliage, Light foliage, Dirt, Snow, Water, and Buildings. Every surface has
its own color picker. Matching hex colors share one material; the menu counts
unique colors and asks you to share them when more than four are selected.
Choices are saved locally in the browser. Feature checkboxes and feature colors
are independent and stay selected when changing the surface palette.

The surface map uses OSM forests/woods for dark foliage and mapped grasslands,
meadows, scrub, farmland, orchards, gardens, and parks for light foliage.
Mapped glaciers/permanent snow use Snow; mapped water areas use Water;
building footprints use Buildings. Unmapped ground uses Dirt. These are mapped
land-cover classes, not satellite-image analysis or current seasonal snow.
A separate bounded request fetches and caches these areas for seven days in
`.cache/landcover/` when Print is selected; areas support up to 50 km per side.
Loading errors expose a retry control instead of inventing coverage.

Triangle centroids select each face's surface class. Color boundaries therefore
follow terrain mesh detail; small building footprints can be smaller than a
triangle. Adjacent surface types use independent triangle corners, so GLB
colors cannot blend across class boundaries. The print palette disables visual
contour tinting, and its base uses Dirt. Lighting affects the preview's
appearance; material colors in files remain the chosen values.

3MF partitions the terrain into closed solids by color, retaining exact terrain
height and shared seams. It follows the [3MF Core specification](https://github.com/3MFConsortium/spec_core/blob/master/3MF%20Core%20Specification.md).
These are multi-part models: match each part to a filament in your slicer.
GLB and preview PNG also preserve the mapped palette; STL has no material colors.

## Configuration

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `TERRAIN_CACHE_DIR` | Directory for cached elevation tiles; ZIP and feature caches default to sibling directories |
| `TERRAIN_FEATURE_CACHE_DIR` | Directory for cached clipped map features |
| `TERRAIN_3DEP_URL` | USGS 3DEP `exportImage` endpoint; defaults to The National Map's 3DEPElevation ImageServer |
| `TERRAIN_GEOCODER_URL` | Nominatim-compatible `search` endpoint for address and place lookup |
| `TERRAIN_OVERPASS_URL` | Overpass endpoint; defaults to `https://overpass-api.de/api/interpreter` |
| `TERRAIN_MAP_TILE_URL` | Alternative map provider URL with `{z}`, `{x}`, `{y}` placeholders |
| `TERRAIN_MAP_ATTRIBUTION` | Attribution HTML for that provider |
| `TERRAIN_MAP_MAX_NATIVE_ZOOM` | Highest native zoom of the terrain provider; defaults to 17 |
| `TERRAIN_TRUSTED_HOSTS` | Comma-separated allowed hosts; defaults to localhost, 127.0.0.1, and [::1] |

The default server binds to loopback. This is a local workstation app, not a
multi-user hosted service. For LAN access, use `--host 0.0.0.0` and explicitly add
your machine's hostname/IP to `TERRAIN_TRUSTED_HOSTS`.

To refresh the bundled example from the live elevation service:

```bash
python scripts/cache_example.py
```

## Development and validation

```bash
python -m pip install -e '.[test]'
python -m pytest -q
```

Tests cover USGS 3DEP raster sampling, missing-coverage errors and source selection, signed/fractional Terrarium decoding, interpolation across tile seams,
cache reuse, input validation, smoothing, watertight geometry and winding,
millimeter scaling, STL encoding, raw data/heightmap round trips, HTTP endpoints,
background job success/failure, default presets, place search caching/errors, ZIP validation/caching/errors,
feature clipping against rotated grids, 3D building tags, roof solids and building parts, other trails, incomplete Overpass responses, water
multipolygons with islands, building heights, feature-job deduplication/retry,
saved colors, mapped surface classes, closed color-part partitions, 3MF
materials and assemblies, and
the actual bundled Roan Mountain mesh.

An optional browser test is in `tests/browser.cjs`. With Playwright installed,
start the separate fixture server with `python scripts/browser_fixture_server.py`
(port 8001), then run `node tests/browser.cjs`. This server supplies synthetic
land-cover regions for tests and never alters the production app on port 8000. Set `TERRAIN_PLAYWRIGHT_PATH`
to the Playwright package directory if it is installed outside this project.
The test intercepts map, ZIP, and feature requests with fixtures, exercises ZIP
navigation and errors, two-point alignment with mouse/touch, cancellation,
every feature category and color, the Boundaries and Trails submenus, raised and 3D buildings, GLB geometry and
water masks, ratio orientation toggles, shared print colors, discrete face
colors, real 3MF downloads, and fixed
frame selection, edge resizing, mouse/keyboard/touch rotation, panning and zooming,
rotated terrain generation, rendering
controls, profiles, every download format, mobile
layout, and offline map handling. It writes artifacts to `test-results/`.

Python modules live in `terrain_app/`; the browser UI lives in
`terrain_app/static/app.js` and `style.css`. Vendored UI dependencies are Leaflet
1.9.4 (BSD-2-Clause) and Three.js 0.180.0 (MIT); their licenses are included in
`static/vendor/`. Terrain source attribution is included in
`terrain_app/data/ATTRIBUTION.txt`, the source-credits download, and embedded in
OBJ, GLB, PNG, and optional metadata exports.

## 3D buildings

With **Buildings** checked, the **3D buildings** option uses OpenStreetMap's
[Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings)
tags, fetched in the same Overpass request as the other layers:

- `building:part` volumes replace the outline of the building they belong to,
  so towers show their setbacks and podiums. `min_height` and
  `building:min_level` lift a part off the ground.
- `roof:shape` with `roof:height` or `roof:levels` (three meters when neither
  is mapped) gives gabled, hipped, pyramidal, and skillion roofs. Gambrel,
  saltbox, and round roofs are drawn as gabled, mansard and half-hipped as
  hipped, and domes, onions, and cones as pyramidal. Ridges follow the
  footprint's longer side unless `roof:orientation=across`; skillion roofs
  follow `roof:direction` when mapped.
- Buildings without these tags stay flat-roofed blocks, exactly as when the
  option is off. Detail depends on OSM: city centers are often richly mapped,
  while most suburban and rural buildings are footprints with no roof data.

The preview, GLB, preview image, and four-color 3MF all use the same shapes.
Roof detail is only visible on small selections: on a 180 mm model of a 5 km
area, a 10 m house is about 0.4 mm tall.

## Trails

**Other trails** are OSM paths, footways, and bridleways, without sidewalks and
street crossings. Ways that belong to the Appalachian Trail are kept out of
this layer so the two toggles do not overlap.

The AT feature follows mapped Appalachian Trail hiking-route relations and named
trail ways from OpenStreetMap, clipped to the selected terrain. Its checkbox and
color picker work independently of Roads, including at low road detail.

### Interface defaults and favorite landscape parameters

Elevations and the profile chart display unexaggerated feet above sea level.
Selection dimensions and grid spacing display feet; profile distances use miles.
Print dimensions stay in millimeters, while raw elevation data and GLB retain
their documented metric units.

Open **Make it yours**, adjust the palette, terrain controls, and map features,
then click **Save as default** to remember those selections in this browser.
This includes feature colors and detail levels, building options, boundary and
trail selections, and all six Print palette colors. Later edits do not replace
these defaults until you save again.

Below **Find your frame**, **Current box parameters** shows copyable JSON with
the current landscape name, unrotated geographic bounds, and clockwise rotation
in degrees. **Copy parameters** copies the JSON for use in an AI request to
update the **Famous landscapes** menu. These parameters track the current map
selection, even before new terrain is generated.
