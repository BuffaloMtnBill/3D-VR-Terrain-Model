# Terrain Studio · 3D Map Extractor

A Python application that turns a rectangle on OpenStreetMap into an interactive
3D terrain model. A fixed, resizable frame selects the map area beneath it.
Runs locally in your browser, with no API key required.
The dark theme uses forest green, brown, and tan. The map opens with terrain and
contour lines; the map-style selector also offers a street map.

## Run

Requires Python 3.11 or newer and a modern browser with WebGL support. No API
keys or accounts are needed. Get the code with `git clone`, or with
**Code → Download ZIP** on GitHub and unzip it.

### Windows

1. Install Python 3.11 or newer from [python.org](https://www.python.org/downloads/windows/).
   Leave **Add python.exe to PATH** ticked in the installer.
2. Double-click **`run.bat`** in the project folder.

The first run sets up a private Python environment in the `.venv` folder and
downloads the required packages, which takes a few minutes. After that it
starts in seconds and opens the app in your browser. Close the window, or press
Ctrl+C in it, to stop. If Windows SmartScreen asks, choose **More info → Run
anyway**; the file is a short, readable script.

To do the same by hand in PowerShell:

```powershell
cd 3D-Map-Extractor
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py --open
```

### macOS and Linux

```bash
cd 3D-Map-Extractor
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:8000**. Stop the server with Ctrl+C.
Use `python app.py --port 8080` to change the port, or `--open` to launch your
browser.

### Install with pip

To install straight from GitHub without cloning, preferably into a virtual
environment:

```bash
pip install git+https://github.com/BuffaloMtnBill/3D-Map-Extractor
terrain-studio --open
```

From a cloned copy, `pip install .` does the same. On Windows, use
`py -m pip` if `pip` is not on your PATH. `terrain-studio` takes the same
`--port` and `--open` options as `app.py`.

To uninstall, use the package name rather than the command name:

```bash
pip uninstall 3d-map-extractor
```

This leaves the packages it depends on installed (deleting the virtual
environment removes those too), and leaves downloaded data in the
[cache folder](#cache-location), which you can delete by hand.

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
   The **Elevation multiplier**, **Base thickness**, and **Contour lines**
   controls sit below Terrain detail and update the model immediately.
4. Use the right-hand **Make it yours** panel, which is always open, to adjust the
   palette and map features. Export model stays in the left sidebar. Orbit with the mouse, scroll to zoom, and
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
The Famous landscapes list comes from `terrain_app/data/DefaultProfiles.txt`.

## Controls

| Control | Effect |
| --- | --- |
| Alpine / Earth / Desert | Three elevation-based color palettes |
| Print | Mapped surface colors for four-filament printing; opens a six-surface color menu |
| Elevation profile | How heights are shaped before the multiplier: Standard, Local relief, or Lowland emphasis (see below) |
| Elevation multiplier | 1× preserves the horizontal-to-vertical ratio; values above 1× emphasize relief |
| Base thickness | Height of the solid base beneath the terrain, as a percentage of the longest horizontal edge |
| Contour lines | Overlays elevation contours at an automatically chosen interval |
| Relief | Lit, colored 3D terrain |
| Map | Drapes the currently visible terrain or street map over the 3D surface |
| Wireframe | Shows terrain triangles |
| Elevation | Top-down elevation color map, in the selected frame's orientation |
| Profile | A movable geographic cross-section, showing unexaggerated elevations |
| Map features and colors | Optional OSM geometry draped over the terrain; railways have two rails and ties, boundaries use dashed lines, and water areas retain islands |

## Elevation profile

The **Elevation profile** selector above the Elevation multiplier chooses how
heights are shaped before that multiplier is applied:

- **Standard** multiplies every height equally.
- **Local relief** separates the terrain into a smoothed trend surface and the
  finer relief around it (a local relief model), then amplifies only the fine
  relief: up to three times at full strength. Ridges, gullies, and terraces
  stand out while broad landforms keep their height. The smoothing radius is
  3% of the grid's longer side.
- **Lowland emphasis** applies a power curve so low ground gets a larger share
  of the same total height. The lowest and highest points and the order of all
  heights are unchanged; valleys and plains gain shape that a plain multiplier
  leaves flat.

**Effect strength** appears for the two non-standard profiles. These profiles
change the model's geometry in the preview, STL, OBJ, GLB, and 3MF. Statistics,
the profile chart, contour lines, surface colors, and the CSV, NumPy, and
heightmap exports keep the real elevations. The chosen profile and strength
are saved in export metadata and in **Save as default**.

## Exports

Choose the **longest horizontal edge in millimeters** (default: 180 mm).
Geometry exports use the current multiplier and base thickness; models always have a solid base. The UI
uses the original elevations; the smoothing slider has been removed.

- **Four-color 3MF:** select Print and use at most four
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
  Meshes are closed solids, suited to slicers.
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

## Print Studio add-ons

**Export** opens the Print Studio, where a *project* (several named projects per framed area)
adds parametric add-ons to the printed model: holes, nail markers, pencil holders, photo
slots, pockets, coaster recesses, stand grooves, magnet pockets and wall hangers in the
underside, plaques (flatten, level or raise a pad, with optional engraved or raised text),
and text labels. Sizes are millimeters of the exported model. "Print as is" (a project
without add-ons) exports exactly as before.

- Cuts go through everything, including map-feature inlays and buildings. Holes, slots, and
  grooves are measured from the surface at their position; pockets and coasters have a flat
  floor measured from the lowest surface point inside them. Added material (plaque pads,
  raised text) uses the add-on's color, or the Dirt color when none is chosen, and counts
  toward the four 3MF filaments.
- The server applies add-ons with manifold mesh booleans to STL, OBJ, 3MF, and a server-built
  GLB; the project is recorded in 3MF, OBJ, GLB, and JSON metadata. Printability checks
  (floors thinner than 0.8 mm, thin walls, overlaps, colors, printer bed size) update as you
  edit, and long exports run as background jobs with progress.
- Text uses the bundled DejaVu Sans Bold font (`terrain_app/data/fonts/`, under the
  [DejaVu font license](terrain_app/data/fonts/DejaVu-LICENSE.txt)).
- **Marker balls:** `terrain_app/data/templates/marker-ball.stl` is a 10 mm push-pin ball for a
  brass nail (24.4 mm exposed, 1.8 mm hole); its dimensions are in `marker-ball.json`. Nail
  markers default to that depth; with *Include marker balls* each nail marker adds one ball
  beside the model in the 3MF, in its own color. The ball can also be downloaded alone (STL,
  3MF, or the Blender source). Regenerate it with
  `blender --background --python scripts/make_marker_ball.py`.
- **Marker platforms:** choose *Platform* as the nail-marker style to turn each nail into a post
  holding a 30 mm round deck (`terrain_app/data/templates/marker-platform.stl`, dimensions in
  `marker-platform.json`). Its hub takes the nail through the same side T-slot as the ball (head
  pocket, shank channel, 1.46 mm snap mouth); the deck top stands 9 mm above the hub's bottom and
  26.5 mm of nail stands below it, so nail holes follow that depth when you switch styles. *On
  top* can print a patch of the terrain around the marker (the *Area lifted* square, shrunk onto
  the deck with its own *Top exaggeration* over a 1.2 mm base) or the mapped building at the
  marker (scaled to fit the deck, at least 4 mm tall; the Buildings layer must be loaded, and a
  marker with no building within 15 m prints bare). The top color counts toward the four 3MF
  filaments. Print a bare platform deck top down on the bed, with no supports (the 3MF lays them
  out that way). A platform with a printed-on top is an assembly of two parts, platform and top,
  that stays aligned in the slicer; it prints upright and needs supports under the deck. Like the
  ball, the nail head (3.2 × 0.8 mm) is assumed: measure yours and edit the constants (shared with
  `make_marker_ball.py`). Regenerate it with
  `~/opt/blender-4.5.14-linux-x64/blender --background --python scripts/make_marker_platform.py`
  (any Blender 4.2 or newer).

API: `GET /api/studio/catalog` (add-on types and parameters), `POST /api/studio/<id>/check`,
`POST /api/studio/<id>/text-outline`, `POST /api/studio/<id>/export` (returns a job; poll
`GET /api/studio/jobs/<job>`, then download `GET /api/studio/jobs/<job>/file`; `"preview": true`
returns JSON mesh parts at a coarser grid), `GET /api/studio/marker-ball?format=stl|3mf|blend`, and
`GET /api/studio/marker-platform?format=stl|3mf|blend` (both take `&color=` for the 3MF).
`POST /api/export/<id>` also accepts an optional `project`.

## Elevation source and geographic limits

[OpenTopoMap](https://opentopomap.org/about) provides the default terrain map
with contour lines, using OpenStreetMap and SRTM data. The street-map option
uses OpenStreetMap's standard tiles. By default, heights come from the public
[Mapzen / Tilezen Terrain Tiles dataset on AWS](https://registry.opendata.aws/terrain-tiles/),
decoded from Terrarium PNG tiles. The program caches these tiles for 30 days in the
`elevation` folder of its cache directory (see [Cache location](#cache-location)). At most 64 tiles are
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
1200 pixels per side), cached for 30 days in the cache directory's `3dep` folder. The extra detail
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
to one request per second, and cache for 30 days in the cache directory's `places` folder, following
the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).
Coverage and address precision depend on OSM.

US ZIP locations come from [Zippopotam.us](https://www.zippopotam.us/), using
GeoNames data. Leading zeros are preserved; ZIP+4 uses its five-digit area.
Locations are representative points for the ZIP area. Lookups cache for 30 days
in the cache directory's `zip` folder. Click Generate terrain after navigating to create its model.

Features come from [OpenStreetMap](https://www.openstreetmap.org/copyright)
through the public Overpass API. One request fetches every category except
buildings for the current terrain; toggling layers or changing colors reuses
that data. Buildings and building parts, by far the largest layer in cities,
are a second request made only when Buildings is first checked. Feature
requests are limited to **50 km per side**, two simultaneous downloads, and, per request,
40 MB of response data, 40,000 OSM elements, and 200,000 input points. Buildings
are a separate request with their own allowance. Queries may run for 60 seconds
on the Overpass server; the app waits up to 75 seconds for the response. Results cache for seven days in
the cache directory's `features` folder. Rotated areas fetch their enclosing geographic extent, then
clip linework and polygons to the actual selected rectangle. Elevation exaggeration moves the overlays with the surface.

Borders represent OSM administrative levels 2–6 (country, state, and county);
city boundaries use levels 7–10. These categories have separate switches,
so disabling Borders leaves selected city or park boundaries intact. Definitions vary by country. Parks include
mapped parks, nature reserves, national parks, and protected areas. Water
includes mapped waterways and water areas, plus open sea: OSM marks the sea
with coastlines instead of water areas, so the app divides the selection along
them and treats the seaward side as water. A selection lying entirely at sea,
with no coastline crossing it, cannot be told apart from land and stays land. Coverage depends on OSM: missing
layers are reported as empty, and service failures offer a Retry button.
Buildings use OSM footprints, courtyards, and mapped height/level tags;
missing heights use an illustrative six meters. Roads and Water are selected on a
first start, along with contour lines; other layers are off until you check
them. Feature data is fetched once a selected layer needs it. This app is intended
for occasional local requests; use your own Overpass endpoint for larger usage.

Road detail uses OSM highway classes: 0% retains motorways, trunk roads, primary
roads and their links; 25% adds secondary roads, 50% tertiary roads, 75% residential
and unclassified roads, and 100% service roads, tracks, and other small roads.
Water source selects USGS 3DHP or OpenStreetMap independently of elevation.
The initial regional default is USGS for US selections and OpenStreetMap
elsewhere; an explicitly chosen source is remembered. USGS supplies flowlines
and waterbody polygons, including legacy NHD where newer elevation-derived
mapping is unavailable. Open-sea geometry still comes from OpenStreetMap.
Source changes apply to the preview, GLB, 3MF, and preview images; the choice
is saved in export metadata. Failed USGS requests offer Retry or a switch to
OpenStreetMap rather than silently changing sources. Both providers support
selections up to 50 km per side. USGS data are cached for seven days.

Water detail retains rivers at every setting, adds canals from 25%, streams
from 80%, and ditches/drains at 100%. For water polygons, the minimum area drops
continuously from two hectares at 0% to zero at 100%. Area is measured from the
full mapped body before clipping, preserving large lakes when only a small
piece lies in the selection. Detail changes reuse loaded data and apply to both
preview and GLB export; the chosen percentages are saved in export metadata.
For USGS channel lines, stream order 4 and above is treated as a river for
this display filter; smaller or unclassified channels are treated as streams.
Network connectors and underground paths are excluded from surface waterways.
Headwater drainageways appear at 100% water detail.

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
the cache directory's `landcover` folder when Print is selected; areas support up to 50 km per side.
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

## Cache location

Downloaded elevation, map features, and search results are kept in a per-user
cache folder, wherever the app is started from:

| System | Folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\TerrainStudio\Cache` |
| macOS | `~/Library/Caches/TerrainStudio` |
| Linux | `$XDG_CACHE_HOME/terrain-studio`, or `~/.cache/terrain-studio` |

The app prints the folder when it starts. It is safe to delete at any time; data
is downloaded again when needed. Set `TERRAIN_CACHE_DIR` to use another place.

## Configuration

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `TERRAIN_CACHE_DIR` | Directory for cached elevation tiles, replacing the default cache location; the other caches become its sibling directories |
| `TERRAIN_FEATURE_CACHE_DIR` | Directory for cached clipped map features |
| `TERRAIN_3DEP_URL` | USGS 3DEP `exportImage` endpoint; defaults to The National Map's 3DEPElevation ImageServer |
| `TERRAIN_GEOCODER_URL` | Nominatim-compatible `search` endpoint for address and place lookup |
| `TERRAIN_OVERPASS_URL` | Overpass endpoint; defaults to `https://overpass-api.de/api/interpreter` |
| `TERRAIN_3DHP_URL` | USGS hydrography FeatureServer; defaults to `https://3dhp.nationalmap.gov/arcgis/rest/services/usgs_3dhp_all/FeatureServer` |
| `TERRAIN_MAP_TILE_URL` | Alternative map provider URL with `{z}`, `{x}`, `{y}` placeholders |
| `TERRAIN_MAP_ATTRIBUTION` | Attribution HTML for that provider |
| `TERRAIN_MAP_MAX_NATIVE_ZOOM` | Highest native zoom of the terrain provider; defaults to 17 |
| `TERRAIN_TRUSTED_HOSTS` | Comma-separated allowed hosts; defaults to localhost, 127.0.0.1, and [::1] |

The default server binds to loopback. This is a local workstation app, not a
multi-user hosted service. For LAN access, use `--host 0.0.0.0` and explicitly add
your machine's hostname/IP to `TERRAIN_TRUSTED_HOSTS`.

To refresh the bundled terrain for the first famous landscape from the live elevation service:

```bash
python scripts/cache_example.py
```

## Development and validation

```bash
python -m pip install -e '.[test]'
python -m pytest -q
```

Tests cover elevation profile reshaping, image-format restrictions on downloads, on-demand building downloads, USGS 3DEP raster sampling, missing-coverage errors and source selection, signed/fractional Terrarium decoding, interpolation across tile seams,
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
Run `node tests/browser-water.cjs` against the same server to verify USGS/OSM
switching, cached sources, saved preferences, and late-response handling.
Set `TERRAIN_CHROMIUM_PATH` when using an existing Chromium executable.
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

## GPS routes (GPX)

**Upload GPX** under *Your landscape* overlays a recorded activity on the map,
the 3D preview, and model exports. Export the activity as GPX from Strava
("Export GPX"), Garmin Connect ("Export to GPX"), or COROS. Tracks and routes
are read with any GPX namespace; files must be under 15 MB and 500,000 points.

The route is stored in geographic coordinates (cached under `routes/` in the
cache folder), so moving or resizing the frame never rescales it: each frame
shows the part of the route inside it. **Frame the route** fits the selection
around it, and a route far from the current frame is framed automatically.
Choose its **line color** and **line thickness** (0.4–6 mm on the printed
model). In 3MF files the route is a color part printed like a trail inlay, and
its color counts toward the four-filament limit; GLB files and preview images
include it. STL and OBJ files contain terrain geometry only, as with other map
features.

### Interface defaults and favorite landscape parameters

The **ft / m** switch in **Follow the ridgeline** sets the display units for the
whole page and is remembered in this browser. Feet is the default: elevations,
selection dimensions, and grid spacing show feet, and profile distances miles.
In meters, the same readouts show meters and kilometers. Profile heights are
always unexaggerated heights above sea level.
Print dimensions stay in millimeters, while raw elevation data and GLB retain
their documented metric units.

Adjust the terrain controls in the left sidebar and the palette and map features
in **Make it yours**, then click **Save as default** to remember those
selections in this browser. This includes the elevation multiplier, base
thickness, contour lines, feature colors and detail levels, building options, boundary and
trail selections, and all six Print palette colors. Later edits do not replace
these defaults until you save again.

Below **Find your frame**, **Current box parameters** is collapsed by default.
Open it for copyable JSON describing the current view: the unrotated geographic
bounds and clockwise rotation, the map zoom, and the right-hand rendering
settings (surface palette, map-feature checkboxes, colors, detail levels, 3D
buildings, and print palette). It follows the map and every setting change,
even before new terrain is generated. The **Copy** button in the panel's
header copies it to the clipboard, whether or not the panel is open.

That JSON is a complete **Famous landscapes** entry apart from its name. The
list is read from `terrain_app/data/DefaultProfiles.txt`, which holds one entry
after another: a line with the name to show, then the copied JSON.

```text
Roan Mountain, TN
{
  "bounds": {"north": 36.129, "south": 36.072, "west": -82.163, "east": -82.038, "rotation_deg": 0},
  "zoom": 12.71,
  "settings": {"palette": "alpine", "controls": {"feature-roads": true}}
}
```

Only the landscapes in that file appear in the list, in file order. Add, remove,
or reorder entries and restart the app. Selecting a landscape frames its area at
the stored zoom (never closer than the area fits the map) and applies its stored
rendering settings; entries without `settings` leave the current settings
unchanged, and unknown or out-of-range values are ignored. A mistake in the
file stops the app at startup with a message naming the entry.

The first entry is shown when the app starts, with its rendering settings unless
this browser has saved defaults. Its terrain is bundled so the first view works
offline; after changing the first entry or its bounds, run
`python scripts/cache_example.py` to capture terrain for it, or the app opens
with an empty preview until you click Generate terrain.

## License

Terrain Studio is released under the [MIT License](LICENSE). Bundled
third-party code keeps its own license (see `terrain_app/static/vendor/`; the bundled
DejaVu Sans Bold font is under `terrain_app/data/fonts/DejaVu-LICENSE.txt`), and
map and elevation data carry the attribution terms listed in
`terrain_app/data/ATTRIBUTION.txt`.
