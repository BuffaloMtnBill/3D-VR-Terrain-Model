# 3D-VR-Terrain

A fork of [Terrain Studio · 3D Map Extractor](https://github.com/BuffaloMtnBill/3D-Map-Extractor) built around an
integrated 3D workflow: the terrain is explored and edited in a VR headset as well as on the page. For safety,
the VR side cannot save a model anywhere: there is no Save menu in VR, and the server has no endpoint that
writes uploaded files to disk.


A Python application that turns a rectangle on OpenStreetMap into an interactive
3D terrain model. A fixed, resizable frame selects the map area beneath it.
Runs locally in your browser, with no API key required.
The dark theme uses forest green, brown, and tan. The map opens with terrain and
contour lines; the map-style selector also offers a street map.

## Run

Requires Python 3.11 or newer and a modern browser with WebGL support. No API
keys or accounts are needed. Get the code with `git clone`, or with
**Code → Download ZIP** on GitHub and unzip it.

**Restart server** in the page header restarts the running server with the same
command it was started with (so edited code takes effect) and reloads the page
once it answers again.

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
cd 3D-VR-Terrain
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py
```

### macOS and Linux

```bash
cd 3D-VR-Terrain
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

It serves HTTPS to your network so a VR headset can connect (see [VR explorer](#vr-explorer)), and opens
**https://localhost:8000** in this computer's browser once the server is up; accept the self-signed certificate
the first time. Stop the server with Ctrl+C. Use `python app.py --port 8080` to change the port, `--no-browser`
to skip opening the browser, or `--local` for plain HTTP on this computer only (no headset).

### Install with pip

To install straight from GitHub without cloning, preferably into a virtual
environment:

```bash
pip install git+https://github.com/BuffaloMtnBill/3D-VR-Terrain
terrain-studio
```

From a cloned copy, `pip install .` does the same. On Windows, use
`py -m pip` if `pip` is not on your PATH. `terrain-studio` takes the same
`--port`, `--local`, and `--no-browser` options as `app.py`.

To uninstall, use the package name rather than the command name:

```bash
pip uninstall 3d-map-extractor
```

This leaves the packages it depends on installed (deleting the virtual
environment removes those too), and leaves downloaded data in the
[cache folder](#cache-location), which you can delete by hand.

## Use

Terrain Studio starts on the **geography selection page**, where you find, frame, and style a place.
Its **Design and export** section opens one of two design pages: **3D model design**, where you add
markers and other add-ons to the whole landscape and export it, and **Silhouette design**, where
elevation-profile slices (or an uploaded route's profile) become flat ridgeline pieces to print, laser
cut, stand on a desk, light on an LED lamp base, or layer in a shadow box.

1. Pick a preset, or type in the one search box: an **address, city, or place
   name**, a **US ZIP code** (five digits or ZIP+4), or a `latitude, longitude`
   pair. It zooms to fit the place it finds, or jumps straight to the coordinates.
   Search and ZIP navigation center the selected frame on the
   location while retaining its size, rotation, and aspect ratio. The selection frame
   stays fixed on screen while you pan the map beneath it. Zoom with the +/−
   buttons or mouse wheel to change the geographic area inside the frame. Buttons
   move in quarter-level steps; the wheel uses continuous fractional zoom with
   reduced sensitivity for precise framing.
2. Choose **Rectangle**, **Circle**, or **Oval** with the map's **Shape** control.
   Circles and ovals have draggable handles on all four borders; circles keep
   equal axes, while ovals resize each axis independently. Their rotation hook
   works like the rectangle's. After **Generate terrain**, the explorer, **3D model
   design**, and STL/OBJ/3MF/GLB exports follow the chosen footprint, including
   clipped map features and added material. Raw elevation and heightmap exports
   retain their enclosing grid and record the selection shape in metadata.
   Drag the rectangle's **right border** or **bottom border** to resize along the frame's
   axes, keeping its opposite corner fixed. Drag the **lower-right corner** to
   rotate around the center without changing the width or height. Hold Shift
   to snap rotation to 15° increments. Focus the corner and use arrow keys for
   1° rotation (Shift: 15°); Home resets the angle. Edge handles also support
   arrow keys. Escape cancels a drag. **Reset frame** restores the default size
   and zero rotation with a rectangular frame. The **two-point alignment button** beside Reset frame
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
4. Use the right-hand **Map layers** panel, which is always open, to choose map
   features. Colors are chosen on the design pages: its **Open Colors** link (or
   **3D model design**) opens the **Colors** card holding the surface palette, the
   Print palette's surface colors, each map feature's color, and the GPS route color.
   The **3D model design** and **Silhouette design** buttons stay in the left sidebar. Orbit with the mouse, scroll to zoom, and
   use the camera reset or auto-rotate buttons. Under **Map features**, check
   roads, train tracks, water, or buildings. **Boundaries** opens a submenu for
   borders, city boundaries, and park boundaries; **Trails** opens one for the AT
   (Appalachian Trail) and other trails. Checking **Buildings** reveals a
   **3D buildings** option. Submenus appear only while their category is checked;
   unchecking the category hides all of its layers and keeps your choices.
   Each has its own color in the design page's Colors card; changes apply immediately to loaded layers.
   Roads and Water also have detail sliders. Lower detail omits minor roads,
   creeks, and smaller water areas while retaining larger mapped features.
5. Move the cross-section slider to inspect profiles along the frame's axes
   (east–west or north–south at zero rotation, chosen beside the slider). The section guide appears on
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
| Alpine / Earth / Desert | Three elevation-based color palettes (Colors card, 3D model design page) |
| Print | Mapped surface colors for four-filament printing; shows six surface colors in the Colors card |
| Elevation profile | How heights are shaped before the multiplier: Standard, Local relief, or Lowland emphasis (see below) |
| Elevation multiplier | 1× preserves the horizontal-to-vertical ratio; values above 1× emphasize relief |
| Base thickness | Height of the solid base beneath the terrain, as a percentage of the longest horizontal edge |
| Contour lines | Overlays elevation contours at an automatically chosen interval |
| Relief | Lit, colored 3D terrain |
| Map | Drapes the currently visible terrain or street map over the 3D surface |
| Wireframe | Shows terrain triangles |
| Elevation | Top-down elevation color map, in the selected frame's orientation |
| Profile | A movable geographic cross-section, showing unexaggerated elevations |
| Map features | Optional OSM geometry draped over the terrain; railways have two rails and ties, boundaries use dashed lines, and water areas retain islands. Checkboxes on the geography page, colors in the Colors card |
| VR | Opens the model in a VR headset (shown only where WebXR is available); see [VR explorer](#vr-explorer) |

## VR explorer

The **VR** button in the 3D preview opens the terrain in a WebXR headset such as a Meta Quest. Headset browsers
allow VR only on secure (HTTPS) pages, which is how the server starts by default:

```bash
python app.py
```

It serves HTTPS on every network interface with a self-signed certificate made for this computer's addresses,
trusts those addresses as hosts, and prints the address to open, such as `https://192.168.0.177:8000`. Open it in
the headset's browser and accept the certificate warning once (choose **Advanced → Proceed**). The certificate is
kept with the cache and made again only when the computer's addresses change. Allow the port through the
computer's firewall if the headset cannot connect.

**Pairing.** Every other device pairs once: the first visit shows a PIN page, and the 6-digit PIN is
printed in the terminal and shown in the page header on the computer itself (HEADSET PIN). A paired device keeps a
cookie and is remembered across server restarts; the computer stores only hashes of those cookies. Five wrong PINs
pause pairing for a minute. The PIN is new each run unless `TERRAIN_PAIRING_PIN` sets it, and
`python app.py --forget-devices` unpairs every device. Pages on the computer itself never need pairing.

**Live link.** Every open page keeps a WebSocket to the server (the LIVE badge in the header). Generation progress
arrives over it instead of by polling, and terrain generated on one device is offered on the others: the page shows
**Open it**, and a headset in VR opens it straight away. The link reconnects by itself when a headset wakes from
sleep, comes back into Wi-Fi range, or the server restarts (the badge shows RECONNECTING meanwhile, and the VR menu
says so); data requests retry too, and a terrain being generated is picked up where it left off.

**Compact surfaces.** The page fetches the terrain as float32 grids (`/api/terrain/<id>?format=binary`), gzipped:
about a third of the JSON size and no number parsing on the headset. In VR the surface is drawn in tiles of 48 × 48
grid cells that share the page's buffers, so at life size the ground out of view is not drawn.

**The headset's page.** The Quest's browser gets a basic page: the map with its selection box and a big **Enter
VR** button (**Full page** in the header shows everything; `?headset` shows the basic page on any browser).

VR has two modes, and works with tracked hands or controllers (put the controllers down and the Quest switches to
hand tracking; your hands are drawn as see-through outlined hands that turn gold while you pinch).

**Map Selection** (where VR starts) is the page's map and selection box in 3D. The box is placed 45° below your
line of sight, straight ahead and facing you (about 55 cm out and 55 cm down, seated or standing), each time Map
Selection opens; it stays there and the map moves beneath it, just as the page's map moves beneath its frame:
whatever is under the box is the selection. The map only slides and turns at the box's level; nothing moves it up or
down. The map is the topographic style, with hill shading and contour lines, drawn in tiles that get
sharper the closer they are to your eyes: lean in, or zoom in, and finer tiles load (a coarse layer underneath means
the map never shows holes while they arrive).

The map stands in **3D relief**: each tile is draped over a low-resolution height grid (17 × 17 points, from
`/api/relief/<z>/<x>/<y>`, which samples the elevation tiles the generator already caches, three zooms coarser so one
download serves up to 64 map tiles). The relief is raised by the page's elevation multiplier, so Map Selection
previews roughly what the model will look like, and changes with it at once. A short skirt along each tile's edge
hides the cracks between tiles of different detail. The box gets low glowing walls so it reads over hills, and a
drag glides at the height where it took the map. **Flat map** on the watch switches the relief off (**3D relief**
switches it back).

You grip the map, and tap the watch and the wrist button with a fingertip (with hands, both stand 6 cm out from the
back of the wrist on a short stalk, turned partly toward your eyes, so the wrist never blocks them); the menus, which open about five feet away,
are chosen with a laser from each hand (shown only while a menu is up). A grip is a pinch or a fist (with the index
finger curled too, so a finger held out to tap is never a grip); with controllers it is the grip button or the
trigger, and each controller taps with the small dot just in front of it.

| Grip | Map Selection |
| --- | --- |
| One hand, and move it | Move the map under the box |
| Both hands, apart / together | Zoom in / out: the box covers less / more ground (its proportions stay) |
| Both hands, turn them | Turn the map, which turns the selection |

Let go of a one-hand drag while still moving and the map glides on, slowing to a stop over about a second (hold
still before letting go for a precise stop; gripping again stops a glide). With hands, a pinch is decided by your
fingertips alone: it ends the moment they part (the headset's own pinch signal lingers after the fingers open, which
used to jerk the map back), and while gripping, the map follows your wrist rather than the fingertips, so opening
them to let go cannot move it.

Every drag, zoom, and turn sets the page's selection when you let go (a glide sets it where the map comes to rest) (and the computer's page follows it while you
move). When the selection changes another way (a search, a shape or aspect change) the map moves to match.

**The watch on your left wrist** (on top of the left controller): tap its dial with your right index finger and a
large radial menu (1.26 m across) opens about five feet (1.5 m) in front of you. Point either hand at a segment (its
laser lights it) and pinch to choose it; with controllers, point and pull the trigger. Each one is the page's own
control. A soft tick (and, with controllers, the lightest buzz) sounds as an option lights, and a click with a firmer
buzz as it is chosen; pressing Generate, here or on the page, sounds a horn blast. The sounds are made in the browser; there are no sound files. The menu is nested, a few segments to a ring: a segment
marked ▸ opens the next ring, and every segment shows its current value under its name.

| Segment | Choices |
| --- | --- |
| Search | A keyboard, empty each time (a search is not kept): type (or say) an address, place, US ZIP code, or "latitude longitude" and press Search; the map goes there at city scale (the page's map at zoom 11 at the closest, so the box covers roughly 15 km, about ten miles, across on a desktop-sized page), and a caption names the place found (if nothing is found, the keyboard comes back with your text and the reason) |
| Area | The shape editor (below): shape, proportions, and turn in one window |
| Terrain ▸ | **Source** ▸ elevation source · **Detail** ▸ terrain detail · **Profile** ▸ elevation profile (standard, local, lowland) · **Multiplier** ▸ − and + one step, −− and ++ ten steps · **Base** ▸ base thickness, the same way |
| Layers ▸ | The map features drawn on the model, each a switch, in groups: **Roads & rail** ▸ (roads, train tracks), **Boundaries** ▸ (borders, city, park), **Outdoors** ▸ (water, AT, other trails), and **Buildings** |
| Settings ▸ | **Flat map / 3D relief** · **Voice: on / off** (listen for the voice commands below, or not) · **Exit VR** ▸ asks first: **Yes, exit** or **Stay** |

The middle of the menu shows where you are (Terrain › Detail) and goes back one ring (or closes the menu on the first
ring); tapping the watch again (or saying "Close menu") closes it from anywhere. The keyboard's keys are chosen
the same way, with the laser and a pinch. While any menu is up the map stays put: grips do not move it.

**The shape editor** floats upright, large, about five feet in front of you: choose Rectangle, Circle, or Oval and a
proportion (1:1, 4:3, 3:4, 16:9, 9:16) with the laser, or point at one of the shape's handles, pinch (or pull the
trigger), and sweep the laser to drag it: the side handle sets the width, the top one the height, and the ring above turns the shape (it snaps back to
north-up within 3°). The window shows the proportions and the turn as you go; each change is applied to the page's
selection when you let go, keeping its middle and its area, and the map under the box follows. **OK** returns to the
menu.

**Voice search.** The keyboard's **🎤 Speak** key records from the headset's microphone (allow it when the headset
asks); **■ Stop** (or eight seconds) ends it, and the words heard replace the text in the box, to check before tapping
Search. A ZIP code read digit by digit is joined up. The headset sends plain 16 kHz samples to the computer, which
transcribes them with Whisper (faster-whisper, on the CPU); nothing is sent anywhere else and nothing is saved. The
first voice search (or command) downloads the speech model once (`small.en`, about 480 MB; `TERRAIN_WHISPER_MODEL=base.en` picks a
smaller, less accurate one, about 140 MB); after that a search takes well under a second.

**The button on your right wrist** (on top of the right controller): tap it with your left index finger. It reads
**Generate** in Map Selection: the box's area is generated (the button shows the progress), and
VR switches to the **model view**, the new model as a 1 m tabletop model to grab, zoom, and turn (pinch it with one hand
in the air to move it, with both to zoom and turn it; controller sticks fly over it). **Pinch the model itself** (within
2 cm of it) to pick it up: it moves and turns with your hand as if you were holding it, and stays where you open your
fingers (a second hand pinching turns that into the two-hand zoom and turn). **Clench a fist** to turn the model in any
direction as your fist turns, about its own center, which stays where it is; open your hand to leave it turned (with
controllers, the grip button turns it; the trigger on the model holds it, and in the air moves it). Each return to the model view sets it level again. A
held hand is steadied (a One Euro filter), so the hand tracking's small jitter does not shake the model or the map, while
quick moves still follow at once. While the map features (roads, water, and the rest) are still downloading, a quiet
**Loading map features…** sign floats well beyond the model, a little above eye level, and fades away once they are in. There the button reads **◀ Map** and goes back.

**The model view's menu** is its own: tapping the watch there opens **Background** ▸, **Layers** ▸, and **Settings** ▸. The
model sits in front of a dark gradient by default; Background changes it to a 360° mellow forest, sandy
desert, moonlit lake, mountain peak above the clouds, space (a planet's edge under a nebula), or Times Square at dusk (in `static/backgrounds/`, made with OpenAI's image generation and joined seamlessly where the
panorama wraps around; the headset's browser remembers the choice). **Layers** is Map Selection's Layers ring plus
**Contour lines**, and **Settings** has Voice and Exit VR. Map Selection keeps its light sky.

**Voice commands.** While you are in VR the microphone stays open for these commands:

| Say | Does |
| --- | --- |
| "Open menu" / "show menu" | Opens the watch's menu |
| "Close menu" | Closes whatever is open: the menu, the search keyboard, or the shape editor |
| "Open terrain", "show layers", "open settings", "open background" | Opens the menu at that ring ("open search" and "open area" open the keyboard and the shape editor) |
| "Generate terrain" | Generates the box's area, as the wrist button does |
| "Back to map" / "show map" | From the model view, back to Map Selection |
| "Exit program" / "exit VR" | Leaves VR |

A caption in front of you shows what was heard. The headset finds where speech starts and stops by itself, so only
those short moments go to the computer (to the same Whisper, told to expect the commands); nothing is sent while you
are quiet, and nothing is saved. Listening pauses while you use the keyboard's Speak key, and **Voice: on / off**
(watch menu ▸ Settings) switches it off and on.

While a menu is open, its options can be said too, and not only those on show: any option in the current mode's menus
("Fine", "Water", "Multiplier", "Moonlit lake", "Contour lines") works from any ring. The menu moves to the ring where
that option lives, then does exactly what tapping it would. On a tie, the option on show wins. The stepper's "plus",
"minus", "plus ten" and "minus ten", Exit's "Yes, exit" and "Stay", and "Back" and "Close" work only while on show.
In the shape editor say "Circle", "Sixteen by nine" or "OK" (and "Search" or "Cancel" at the keyboard). The names
are sent along with the speech, those on show first, so Whisper expects them.

**From the headset to the computer.** While you work in VR, the headset hands its workspace to the server a few
times a second: the cut (even mid-drag), its name, the elevation source and detail, every model and map-layer
setting, the model size, and the generated terrain. It is kept in the server's memory only, never on disk. The
computer's page follows along live (**FOLLOW HEADSET** in the header, on by default): its map frame, sliders, and
settings move as you edit, and a cut generated in VR opens there too, ready to export with the page's usual
export. With following off, the page keeps its own view and offers **Continue here** instead; a page opened later
offers the headset's last work for two hours.

Models cannot be saved from VR. An export started while in VR is refused, and nothing is written to the
server computer.

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

### Profile panel: choosing the slice type

The profile panel on the geography selection page chooses the type of elevation
profile to display. **Straight slice** uses the slider and direction selector to
show a cross-section east–west or north–south (at zero rotation).

**Ridgeline · two points** shows the highest way between two locations. Press
**Pick two points**, then click two places on the map to set markers A and B
(draggable). The ridgeline first finds the highest saddle that any path between
the points must cross (the bottleneck of a maximum spanning tree), then follows
the shortest path that never drops below that saddle, weighted toward high
ground to trace the crest. The orange line on the map shows the path; the chart
plots elevation against distance from A.

**Viewpoint skyline** displays the highest elevations visible from a location
across a chosen bearing and field of view, with Earth's curvature and standard
atmospheric refraction (k = 0.13) applied. Press **Pick viewpoint**, then click
where you stand (draggable marker). **Facing** sets the compass bearing
(0–360°); a newly placed viewpoint faces the middle of the selection box, and
dragging it re-aims it there unless you have turned Facing yourself. **View** the field of view (60–360°), **Eye** the eye height (standing
2 m, tower 15 m, hilltop 100 m, aerial 400 m), and **Layers** splits the view
into 1–5 distance bands. For each bearing the skyline is the highest elevation
angle; the chart plots degrees above horizontal against bearing, with nearer
bands in darker shades. The dashed wedge on the map shows the field of view.
**Beyond** (everything, 250 m–10 km) leaves out terrain nearer than that, as if
the foreground were cleared. **Out to** (Horizon by default, or 1–50 km) cuts off
terrain farther than that: the skyline, the bands, the detected ridges, and the
layered glow and diorama designs built from them end at that distance, and the
wedge on the map stops there. **Detect ridges** replaces the bands with up to 7
ridgelines found in the view: visible crests with hidden ground behind them,
grouped by distance (groups at least ~16 % farther apart, so one ridge seen at a
slant stays one), nearest first; the status lists their distances.

**Viewpoint ridgeline** uses the same controls with ridge detection always on: the
chart draws each ridgeline seen from the viewpoint as its own line, labeled with its
distance, and the map draws where each ridge's crest runs on the ground. In both
viewpoint modes a click on the map moves the viewpoint; a viewpoint on the frame's
edge sees no terrain in the directions that leave it.

Points saved for another area (after moving the frame and generating again) are
dropped when they fall outside the new terrain, and picking starts again.

Both modes see only the generated terrain inside the frame: to include distant
mountains, frame and generate a larger area. Points stay as latitude/longitude,
so moving or resizing the frame keeps them on the ground; the chosen mode and
all points are remembered in the browser.

API: `POST /api/profile/<terrain id>` with `{"mode": "ridgeline", "start":
[lat, lon], "end": [lat, lon]}` or `{"mode": "viewpoint", "point": [lat, lon],
"bearing": 0–360, "fov": 10–360, "eye_m": 0–500, "bands": 1–5, "min_radius_m":
0–50000, "ridges": false}` (with `"ridges": true`, `bands` is 1–7 ridges). Responses
include `mode`, `path`, `distances`, `heights`, `length_m`, `highest_m`,
`lowest_m` (ridgeline) or `azimuths`, `angles`, `skyline_m`, `bands`,
`band_edges`, `farthest_m`, `eye_elevation_m`, `point`, `rays`, `bearing`, `fov`,
`min_radius_m`, and `ridges` (`distance_m`, `near_m`, `far_m`, `coverage` of each
detected ridge; its skyline is in `bands`) (viewpoint).

## Exports

Choose the **longest horizontal edge in millimeters** (default: 180 mm).
Geometry exports use the current multiplier and base thickness; models always have a solid base. The UI
uses the original elevations; the smoothing slider has been removed.

- **Four-color 3MF:** select Print in the **Colors** card and use at most four
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

## Design page add-ons

**3D model design** (the Print Studio) opens a full-page workspace where a *project* (several named projects per framed area)
adds parametric add-ons to the printed model: holes, nail markers, pencil holders, photo
slots, pockets, coaster recesses, stand grooves, magnet pockets and wall hangers in the
underside, plaques (flatten, level or raise a pad, with optional engraved or raised text),
and text labels. Sizes are millimeters of the exported model. "Print as is" (a project
without add-ons) exports exactly as before. The **Start from** card's preview turns the model slowly in 3D (drag to
orbit): point at a template, or Tab to it, to see its add-ons placed without changing the project;
otherwise it shows the active project.

Its right column holds the **Colors** card: the surface palette (Alpine, Earth, Desert,
Print), the Print palette's six surface colors with the surface-map status and color count,
one color per map feature in the geography page's order (colors of layers that are off are
dimmed but stay editable), and the GPS route color once a route is loaded. A line under the
feature colors counts 3MF filaments across surfaces, enabled features, the route, and add-ons.
Changes repaint both the design page's view and the geography page's preview.

- Cuts go through everything, including map-feature inlays and buildings. Holes, slots, and
  grooves are measured from the surface at their position; pockets and coasters have a flat
  floor measured from the lowest surface point inside them. Added material (plaque pads,
  raised text) uses the add-on's color, or the Dirt color when none is chosen, and counts
  toward the four 3MF filaments.
- The server applies add-ons with manifold mesh booleans to STL, OBJ, 3MF, and a server-built
  GLB; the project is recorded in 3MF, OBJ, GLB, and JSON metadata. Printability checks
  (floors thinner than 0.8 mm, thin walls, overlaps, colors, printer bed size) update as you
  edit, and long exports run as background jobs with progress.
- **Profile** shows the elevation-profile slice from the geography selection page as the printed model's
  silhouette in millimeters (base band, terrain, and add-on cuts and fills crossing the slice),
  in true proportions or stretched, or as real elevation. Its direction and position slider are
  the geography selection page's own, so both always show the same slice. **Cut the 3D view here** clips the
  model and add-on ghosts at the slice; point at the chart to read heights and cut floors.
- Text uses the bundled DejaVu Sans Bold font (`terrain_app/data/fonts/`, with DejaVu Sans, Oblique,
  and Bold Oblique for the silhouette page's text editor; under the
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

## Silhouette design page

**Silhouette design** turns the elevation profile's slice into a flat piece: the ridgeline on top
of a solid base strip, shown to scale in a front view (and a 3D view you can orbit). Its direction
and position sliders are the geography selection page's own profile controls, so the chart and the
dashed line on the map follow them; **Print from** and **Print to** keep only part of the slice.

The page always opens on the profile the Follow the ridgeline chart shows (straight slice, two-point
ridgeline, or viewpoint), except designs built from a GPX route. A newly generated area starts on the
multi-layer **Layered glow** preset, built from the viewpoint's ridges when one is drawn.

The **Heights** source can also be **Ridgeline (geography page)** or **Viewpoint
skyline (geography page)**, using the profile drawn on the geography page;
opening the silhouette page while the geography page shows one of them selects
it automatically. A viewpoint skyline is printed as it looks from the viewpoint
(lengths on a cylinder around the viewer, so true proportions match the view);
with multiple layers (shadow box or layered lamp presets) each layer is one
distance band, nearest ridges at the front, with nearer bands narrower. When the
geography page has **Detect ridges** on, the layered presets use the detected
ridges instead: one layer per ridge (the layer count follows them within the
preset's limits; with fewer ridges than its minimum it falls back to bands), and
terrain nearer than **Beyond** and farther than **Out to** is left out either way. **Thicker when closer**
(on by default for the Layered glow and the Layered mountain diorama when the
source is a viewpoint) sets each layer's thickness by its distance on a log
scale, from **Nearest** (3 mm) to **Farthest** (1.5 mm for the lamp, 1.2 mm for
the box), to 0.1 mm; the layer list shows each one ("Layer 1 (front) · ridge
0.6 mi · 3.0 mm"). Comb and spacer-comb slots are each layer's own thickness +
0.3 mm, and parts in the files are named with their thickness ("Layer 2 · 2.2
mm"). A ridgeline makes a single layer. Silhouette requests use `source:
"ridgeline"` with `ridge_start` and `ridge_end`, or `source: "viewpoint"` with
`view_point`, `view_bearing`, `view_fov`, `view_eye_m`, `view_min_radius_m`
(0–50000), and `view_ridges`; `thickness_by_distance`, `thickness_near_mm`, and
`thickness_far_mm` (1.2–30) set thickness by distance, and a layer's own
`thickness_mm` overrides it. Outlines give each layer `thickness_mm` and, for a
viewpoint, `distance_m`, plus the `ridges` used.

**Edit ridgelines** in the front view lets you change the printable curves directly.
Click a curve or its checkbox to select it; Ctrl/Shift-click selects several.
Use **Delete selected** or the Delete key to remove selected ridges, keeping at
least one. Deleting a ridge keeps the other original ridges and rebuilds the
comb slots and printable parts; it does not redetect or regroup the terrain.
Drag anywhere along a curve to pull that region smoothly. **Pull width** sets
how much neighboring curve moves; sideways pulls preserve the left-to-right
order, and downward pulls keep the solid base intact. **Undo**, **Redo** and
**Reset ridgelines** restore changes; Escape cancels a drag. The edits apply to
the 3D view and STL/3MF/SVG exports, are saved per framed area, and are included
in the settings JSON. Width and base-height changes preserve edits; changing
the source, slice, viewpoint, detection count, smoothing or vertical scale starts
with fresh curves. Cloud panels remain decorative; deleting down to a single
terrain ridge leaves out the cloud background until more ridges are restored.

**Colors** (in the Export card) fit a four-filament printer. **Color by distance** gives the layers
up to four colors, **Nearest**, 2, 3, and **Farthest**: the layers, nearest first (front to back for
slices), fall into contiguous groups as even as possible (seven layers: 2, 2, 2, 1), and fewer
layers than colors use the nearest ones. Comb bases, spacer combs, and stand feet take the farthest
color used, so the 3MF has at most four materials; parts sharing a color share one material. A
caption or markings in their own color count too: a fifth color is a check warning, and the 3MF
export refuses it ("Use at most four colors: share the text color with one of the distance
colors."). New pieces fade the four colors from the body color to the text color, so an engraved
caption shares the farthest one. The card shows "N of 4 filament colors".

With a viewpoint's ridges or bands (two or more, not in a shadow box), **Pieces** can be **One
piece, color zones** instead of separate layers: every ridge stands on one base strip, zone 1 is the
nearest ridge's outline with the base strip, and each farther zone is what of its ridge shows above
the nearer ones (slivers under 0.2 mm wide join the next zone), so the zones tile the piece. Each
zone takes its distance color and, with **Thicker when closer**, its own thickness from the shared
flat back, so the piece steps toward you and prints flat. Text, ticks, and pegs sit on the nearest
zone; wall holes, keyholes, the desk stand, and the lamp tab (hanging from the base strip) apply to
the whole piece; the comb's spacing and base steps are hidden. The 3MF has one part per color
(ridges sharing a color merge, "Zones 1, 2"), the STL is the zones merged into one solid, and the
SVG puts each color's zones in its own filled group under the cut outline. The front and 3D views
draw the zones in color (and the steps), and the parts list names each zone ("Zone 1 (nearest) ·
ridge 0.6 mi · 4.0 mm · color #234e40"). Requests use `color_by_distance`, `distance_colors` (one to
four hex colors, nearest first), and `color_zones`; outlines add `zones` (each with `name`, `color`,
`thickness_mm`, `distance_m`, and `polygons`) and the filament `colors`.

**Cylinder lamp** (in the Export card) wraps the silhouette around a round lithophane shade in CylinderLamp, the lamp-making
app beside this one: the layers' ridge curves (with any ridgeline edits) go to it, nearest first, and it opens in a new
tab, starting itself from `$CYLINDERLAMP_DIR` (default `../CylinderLamp`) if it isn't running at `$CYLINDERLAMP_URL`
(default http://127.0.0.1:5057). There each layer becomes a band of wall thickness - the sky thinnest, the nearest ridge
thickest - so the range glows in steps. The handoff file goes in `$TERRAIN_LAMP_HANDOFF` (default
`~/.local/share/terrain-studio/lamp-silhouettes`; the newest 50 are kept). `POST /api/silhouette/<id>/cylinder-lamp`
takes the silhouette request plus `name` and answers `id`, `url`, `running` and `layers`; with `?download=1` it returns
the handoff file, which CylinderLamp can also open.

- **Shape:** width (the piece's length, 40–400 mm; the printed part of the slice fills it), vertical
  scale (× true proportions at that width, 0.5–100; it starts at the elevation multiplier), base height
  under the lowest point, thickness, smoothing (a moving average plus a simplification that drops
  points), true elevations, the model's shaped elevation profile, or the **uploaded route**, and mirror.
- **Text:** a caption of up to three lines on the base (DejaVu Sans Bold, starting as the place name),
  engraved, raised from the front face, or cut through as a stencil (thin bridges keep the insides of
  O, A, and e attached), at the left, center, or right. The lamp designs (Edge-lit ridgeline, both
  Layered glows, Skyline night-light) start without text; the Stencil lamp keeps its cut-through
  name, since lighting the letters is its point.
  - **Edit text…** opens the text editor for layouts with more than one size: up to six lines, each
    with its own text, size (capital-letter height, 1–40 mm), style (Regular, Bold, Italic, Bold
    italic; DejaVu Sans), and letter spacing (−20 to +100 % of its letter height added between
    letters), plus the block's alignment (the lines left, centered, or right within it), line spacing
    (baseline to baseline, × the lower line's size), style, depth, and color. A name over a smaller
    italic address, left-aligned, is a few clicks. The preview is drawn from the server's own outlines,
    so it is exactly what prints; **Plain text** returns to a simple caption. The presets with a
    caption (trail memory, elevation chart, anniversary, race) start with a block: a bold first line
    and smaller lines under it.
  - **Moving the text:** the front view draws a dashed box with a move grip around the text: drag it
    anywhere on the front piece, or focus it and nudge with the arrow keys (Shift: 5 mm). It snaps to
    the piece's center line and to the base strip's middle within 2 mm (a guide shows), and **Reset
    text position** puts it back on the base strip; choosing Left, Center, or Right does too. The text
    must sit on material: 1.2 mm in from the edges for engraved or stencil text, clear of the lamp
    comb's slots and the shadow box's comb ends, and on the nearest color zone (zones differ in
    thickness, so the text stays on zone 1's face). Dropped where it would not fit, it comes back to
    the nearest place it fits, and Checks says so. The 3D view and every export follow the position;
    presets reset it, and it is remembered per framed area with the other settings.
- **Mounting:** a desk stand (two feet with a slot the thickness plus 0.2 mm wide, printed beside the
  piece in the same file), two round wall holes, or two keyholes.
- **Exports:** STL (one solid, lying flat with its front face up; a design with several parts
  downloads as a ZIP of one STL per part), 3MF (every part as a named color part, laid out flat side
  by side), SVG (outlines, wall holes, and text as paths in millimeters for laser cutting or vinyl;
  several layers and the combs' side views each get their own group), and the settings as JSON.
  Checks list the size, the lowest point, text that is trimmed or too small, pegs that overlap the
  text, pieces that miss their tab or box, and parts larger than a 256 mm bed; the Export card lists
  the parts and their sizes.

### Start from: design presets

**Start from** at the top of the left panel sets everything a design needs; **Custom** is the plain
piece above. Each preset keeps your slice, caption, and colors where they still make sense and shows
its own settings below the picker. Every size is editable: **measure your lamp's slot and your box's
inside** and type them in. Under the picker, a **preview** turns the design slowly in 3D (drag to orbit): point at a preset, or
Tab to it, to see it built from your current slice and settings without applying it; otherwise it shows
your current design, with its size and number of layers below.

**Glow lamps** stand in an LED lamp base, the kind with a slot on top that lights a panel from its
edge. They share a **lamp-base fit**: slot width (4.0 mm), length (160 mm), depth (8 mm), and
clearance (0.2 mm). A straight tab (slot width − clearance thick, slot length − 2 × clearance long,
slot depth tall) is centered under the piece, flush with its back face so both print flat; the piece
itself may be wider than the slot. Checks warn when the piece is narrower than the tab.

- **Edge-lit ridgeline:** one panel exactly the tab's thickness, with a 0.6 mm engraved caption that
  catches the light. Print it in clear or translucent PETG at 100 % infill and 0.12 mm layers.
- **Stencil lamp:** an opaque 3 mm piece with a large cut-through caption; the lamp lights the letters.
- **Layered glow:** 2–4 thin panels (3 by default) from slices at 25, 50, and 75 % of the frame stand
  in a printed **comb base** whose tab drops into the lamp (from a viewpoint with detected ridges: one
  panel per ridge, closer panels thicker). Slots are each panel's thickness + 0.3 mm, centers
  6 mm apart with at least 1.2 mm between them, 5 mm deep (the caption stays above them), and each panel's base is a step (8 mm) higher
  than the one in front so rear ridges rise above front ones. Print the panels translucent, the front
  darkest; print the comb base clear.
  Beneath the layer options, a number line shows slice locations or shaded
  viewpoint distance groups, with each layer's color, distance, and thickness.
- **Layered glow with clouds:** the layered glow with Clouds on: a puffy, decorative cloud panel stands
  behind the ridges in its own slot at the back of the comb base. Print the clouds white or the
  palest translucent filament.

The 3D view and the Start from preview show glow lamps standing on a round LED lamp base (a faint
cylinder a little wider than the slot, with the slot dark on top).

**Printing** (glow lamps and shadow boxes) makes the parts easier to print:
- **Minimum feature** (1 mm; 0 keeps everything) trims ridge spikes and slivers narrower than that
  from each panel (a morphological opening that keeps square corners and the base edge in place),
  since they are only a couple of extrusion lines wide and snap; bits left floating are dropped so
  every panel stays one piece. Checks note when something was trimmed.
- **Comb slot clearance** (0.3 mm) is added to each panel's thickness for its slot in the comb base
  or spacer combs: raise it if panels won't go in, lower it if they wobble.
- The comb base prints slots down, so each slot's mouth on the bed has a 0.4 mm chamfer (less where
  the walls between slots are thin) against elephant's foot; it also guides the panels in.
- Checks warn when a rear panel nowhere shows 1.5 mm above the panels in front of it.
  Ridge groups are approximate; decorative layers are labelled separately.
  **Puffy clouds behind the terrain** adds a rounded cartoon-cloud panel as
  the final rear layer, with a selectable color. The lamp base or shadow-box
  spacer combs include its extra slot; it is a separate printable part in the
  STL ZIP and 3MF. Clouds do not count toward the terrain-layer count and are
  available for separate layered lamp/box designs.
- **Skyline night-light:** a slice through town that **includes buildings**: along the slice, the
  profile rises to the tallest mapped building within a corridor (30 m wide), standing on its lowest
  ground. Turn on the Buildings map layer and let it load first. Shaped heights, a stencil name, and
  the lamp tab.

**Shadow boxes** share a **box fit**: inner width (200 mm), height (150 mm), and depth (40 mm). Pieces
are the inner width less 1 mm, heights are cut flat at the inner height, and two printed **spacer
combs** (12 mm wide, 8 mm tall, one per side, the box's depth less 0.5 mm long) hold every layer in a
slot the thickness + 0.3 mm wide, evenly spaced from front to back. An optional **photo slot** (1 mm)
behind the last layer holds a photo, card, or map.

- **Layered mountain diorama:** 3–7 layers (5 by default) at slice positions spread across the frame
  from its near side (the front layer) to its far side, each base a step higher, colored from the
  body color at the front to palest at the back. An optional **LED channel** (5 × 2 mm) across the
  combs behind the layers holds an LED strip.
- **Trail memory box:** the uploaded route's elevation profile (the slice without a route), a photo
  slot, a 1.8 mm **summit pin hole** 10 mm deep drilled down from the highest point for the bundled
  brass-nail marker, and the route's name and date as the caption.
- **Elevation chart box:** the route's profile with a caption of its name, distance and climb, and
  date, and **distance ticks** engraved along the base every mile or kilometer (following the ft / m
  switch), labeled where they have room.
- **Anniversary box:** a stencil caption of names and a date, one layer at the chosen slice, and a
  photo slot behind.

**Flat pieces — Ridgeline color zones:** one piece from a viewpoint with detected ridges (2–7, 4 by
default) as color zones, thicker when closer (4 mm nearest to 1.6 mm farthest), a 12 mm base with a
0.6 mm engraved caption, and a desk stand. Assign each 3MF color part its filament.

**Race profile — running or cycling:** the race's elevation along its length from the uploaded GPX,
distance ticks (running every 1 mile or kilometer, cycling every 10), START and FINISH engraved at the
ends, a three-line caption of the race name, date, and your finish time (typed in its own field), and
three round **medal pegs** (6 mm × 20 mm, standing out of the front face along the bottom of the
base), with keyholes to hang it; the stand or mirror work too.

**Route profiles** use the distance along the uploaded route against its elevation, segments joined
in order, with the same vertical-scale meaning as a slice (true proportions at the piece's width, ×
the scale; route presets pick a scale that makes the climb about 50 mm tall). Elevations come from
the GPX's `<ele>` values, smoothed over about 100 m; a GPX without them samples the terrain, which
needs the whole route inside the generated frame (otherwise: "This GPX file has no elevations;
re-export it with elevation or frame the whole route."). Routes uploaded before elevations were
kept need uploading again. Trim applies to the route too.

Settings, the chosen preset, and its fields are saved in the browser for each framed area. The API
is `POST /api/silhouette/<id>/outline` (the preview: outlines, text, markings, and mount marks in mm,
x from 0 at the left and y up, every layer with its assembled position, the fit's parts, a parts list
with sizes, and warnings) and `POST /api/silhouette/<id>/export` with the same JSON body plus
`format` (`stl`, `3mf`, `svg`, or `json`). The body takes `direction` (`ew` or `ns`), `position` and
`trim` (percent), `width_mm`, `vertical_scale`, `base_mm`, `smoothing`, `source` (`true`, `shaped`
with `relief` and `relief_strength`, or `route` with `route_id`), `mirror`, `text` (up to three lines
of 60 characters), `text_size`, `text_style` (`engrave`, `emboss`, `stencil`), `text_depth`,
`text_align`, `mount` (`none`, `stand`, `holes`, `keyholes`), `hole_diameter`, `thickness_mm`,
`body_color`, and `text_color`, and for presets `preset`, `layers` (1–7 of `{position, base_mm,
color}`, front first), `fit` (`none`, `lamp`, `box`), `slot_width`, `slot_length`, `slot_depth`,
`slot_clearance`, `layer_spacing`, `box_width`, `box_height`, `box_depth`, `photo_slot`, `photo_gap`,
`led_channel`, `led_width`, `led_depth`, `include_buildings`, `building_corridor_m`, `summit_pin`,
`pin_diameter`, `pin_depth`, `peg_count`, `peg_diameter`, `peg_length`, `ticks`, `tick_every`,
`units` (`ft` for miles, `m` for kilometers), and `start_finish`. The presets themselves live in
`terrain_app/data/silhouette-presets.json`.

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
  coordinates, and enclosing geographic bounds. Round model footprints use a
  128-sided ellipse while retaining the enclosing elevation grid for sampling.
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

**Print** replaces Slate in the surface palettes. Selecting it in the design page's
**Colors** card shows colors for Dark foliage, Light foliage, Dirt, Snow, Water,
and Buildings beneath the palette. Every surface has its own color picker. Matching
hex colors share one material; the card counts unique colors and asks you to share
them when more than four are selected.
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
| `TERRAIN_WHISPER_MODEL` | Speech model for VR voice search (faster-whisper name); defaults to `small.en` |
| `TERRAIN_PAIRING_PIN` | Fixed 6-digit pairing PIN; a new random one each run by default |
| `TERRAIN_TRUSTED_HOSTS` | Comma-separated allowed hosts; defaults to localhost, 127.0.0.1, and [::1] |

By default the server listens on every interface over HTTPS, and every device other than this computer must pair
with the PIN first. This is a home-network workstation app, not a multi-user hosted service. `--local` binds to
loopback over plain HTTP instead, with no pairing. In local mode, `--host` accepts only a loopback IP address
or `localhost`; network addresses such as `0.0.0.0` are rejected. Omit `--local` when connecting a headset over Wi-Fi.

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

The browser tests (`tests/browser*.cjs`) drive a real Chromium with Playwright; the VR ones also use Meta's IWER
WebXR emulator. Both are pinned in `package.json`. Set up once (Node.js 18 or newer), then run them all:

```bash
npm install          # Playwright and IWER, into node_modules/
npm run setup        # Playwright's Chromium (about 120 MB, shared in ~/.cache/ms-playwright)
npm test             # starts the fixture server, runs every browser test, prints a summary, stops the server
npm test -- vr hands # only some: tests/browser-vr.cjs and tests/browser-vr-hands.cjs (`main` is tests/browser.cjs)
```

`npm test` runs `scripts/run-browser-tests.cjs`: it starts `scripts/browser_fixture_server.py` with the project's
`.venv` Python on port 8001 (`TERRAIN_TEST_PORT` picks another), runs each test against it in turn, and exits
non-zero if any fails. The fixture server supplies fixed landscapes and synthetic land-cover regions and never
alters the production app on port 8000; the tests intercept map tiles, geocoding, and feature requests, while
elevation still goes through the server's normal tile cache (the first run downloads some). A single test can also be
run by hand against a fixture server you started: `node tests/browser-water.cjs`. `TERRAIN_PLAYWRIGHT_PATH` and
`TERRAIN_IWER_PATH` point at packages installed elsewhere.

`node tests/browser.cjs` is the main page test.
Run `node tests/browser-water.cjs` against the same server to verify USGS/OSM
switching, cached sources, saved preferences, and late-response handling.
`node tests/browser-studio.cjs` covers the 3D model design page and `node tests/browser-silhouette.cjs`
the silhouette design page (the shared slice, text and mount settings, STL and SVG downloads, saved settings).
`node tests/browser-ridge-edit.cjs` checks curve dragging, cancellation, multi-ridge deletion, Undo/Redo, exports, and saved edits.
`node tests/browser-selection-shapes.cjs` checks circle/oval border dragging, rotation, generation, the 3D design handoff, and clipped GLB exports. The fixture server uses synthetic elevations for round selections.
`node tests/browser-vr.cjs` drives VR with controllers on an emulated Meta Quest 3 (the `iwer` npm package; set
`TERRAIN_IWER_PATH` to its `build/iwer.min.js` if it is installed elsewhere): Map Selection (tiles that sharpen as
you lean in, dragging, zooming, and turning the map, the page's selection following), every watch menu and the
keyboard search, Generate and ◀ Map on the right wrist, then the model view (flying, grabbing, zooming, turning, the
tiled surface, the live link reconnecting) and that nothing can be saved from VR.
`node tests/browser-vr-hands.cjs` does the same workflow with hands (pinches, fingertip touches on the watch, keys,
and wrist button), with a second page standing in for the computer: it follows the box, opens the generated model,
and exports an STL. `node tests/browser-headset-page.cjs` checks the headset's basic page.
`node tests/browser-vr-voice.cjs` plays spoken commands (`tests/fixtures/voice-*.wav`, made with espeak-ng) into
Chromium's fake microphone and checks each one acts; `TERRAIN_REAL_SPEECH=1` has the fixture server's Whisper hear them
too (instead of a stand-in).
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
1.9.4 (BSD-2-Clause) and Three.js 0.180.0 (MIT, with its GLTFLoader and BufferGeometryUtils addons); their
licenses are included in `static/vendor/`. The VR hand models in `static/vendor/hands/` are the generic hand from
WebXR Input Profiles 1.0.19 (MIT, `hands/LICENSE.md`). Terrain source attribution is included in
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
Each point keeps its elevation (smoothed over about 100 m) for route profiles on the silhouette page,
and the first point's time gives the route its date.

The route is stored in geographic coordinates (cached under `routes/` in the
cache folder), so moving or resizing the frame never rescales it: each frame
shows the part of the route inside it. **Frame the route** fits the selection
around it, and a route far from the current frame is framed automatically.
Choose its **line thickness** (0.4–6 mm on the printed model) beside the
route; its **line color** is in the 3D model design page's **Colors** card,
which shows it while a route is loaded. In 3MF files the route is a color part printed like a trail inlay, and
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

Adjust the terrain controls in the left sidebar, the map features in **Map layers**,
and the palette and colors in the design page's **Colors** card, then click
**Save as default** (in **Map layers**) to remember those
selections in this browser. This includes the elevation multiplier, base
thickness, contour lines, feature colors and detail levels, building options, boundary and
trail selections, and all six Print palette colors. Later edits do not replace
these defaults until you save again.

Below **Find your frame**, **Current box parameters** is collapsed by default.
Open it for copyable JSON describing the current view: the unrotated geographic
bounds and clockwise rotation, the map zoom, and the rendering settings from
**Map layers** and the Colors card (surface palette, map-feature checkboxes, colors, detail levels, 3D
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
DejaVu Sans fonts are under `terrain_app/data/fonts/DejaVu-LICENSE.txt`), and
map and elevation data carry the attribution terms listed in
`terrain_app/data/ATTRIBUTION.txt`.
