# 3D-VR-Terrain-Model

The model-only version of [3D-VR-Terrain](https://github.com/BuffaloMtnBill/3D-VR-Terrain): the same VR map and model
explorer, without VR silhouette mode (the viewer marker, ridge preview and sunset view), and a computer page kept to
just the model: frame a place, generate it, and export it to 3D print as a standard or multicolor model. It
branches from 3D-VR-Terrain before silhouette mode was added.

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
cd 3D-VR-Terrain-Model
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py
```

### macOS and Linux

```bash
cd 3D-VR-Terrain-Model
./run.sh
```

`run.sh` sets up `.venv` on the first run (and again whenever `requirements.txt`
changes), then starts the app; extra arguments are passed to `app.py`. To do it by hand:

```bash
cd 3D-VR-Terrain-Model
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
pip install git+https://github.com/BuffaloMtnBill/3D-VR-Terrain-Model
terrain-studio
```

From a cloned copy, `pip install .` does the same. On Windows, use
`py -m pip` if `pip` is not on your PATH. `terrain-studio` takes the same
`--port`, `--local`, and `--no-browser` options as `app.py`.

To uninstall, use the package name rather than the command name:

```bash
pip uninstall 3d-vr-terrain
```

This leaves the packages it depends on installed (deleting the virtual
environment removes those too), and leaves downloaded data in the
[cache folder](#cache-location), which you can delete by hand.

## Use

The computer's page is kept to just the model: you find and frame a place, choose its map layers, generate
it, and export it to 3D print. There are no design pages, silhouettes, elevation profiles, or GPS routes in this
version. **Export model** opens the [model view](#model-view-and-export), which also opens by itself when a model
is generated in the headset.

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
   works like the rectangle's. After **Generate terrain**, the explorer and the STL and 3MF exports follow
   the chosen footprint, including clipped map features.
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
   features. Orbit with the mouse, scroll to zoom, and
   use the camera reset or auto-rotate buttons. Under **Map features**, check
   roads, train tracks, water, or buildings. **Boundaries** opens a submenu for
   borders, city boundaries, and park boundaries; **Trails** opens one for the AT
   (Appalachian Trail) and other trails. Checking **Buildings** reveals a
   **3D buildings** option. Submenus appear only while their category is checked;
   unchecking the category hides all of its layers and keeps your choices.
   Roads and Water also have detail sliders. Lower detail omits minor roads,
   creeks, and smaller water areas while retaining larger mapped features.
5. Click **Export model** to download it for 3D printing, or save a PNG of the preview.

The default Roan Mountain terrain is a **real bundled DEM**, downloaded from
Mapzen Terrain Tiles. It renders without network access. New area extraction and
map tiles, place search, ZIP lookup, and feature layers require internet access. The UI libraries are bundled locally.
The Famous landscapes list comes from `terrain_app/data/DefaultProfiles.txt`.

## Controls

| Control | Effect |
| --- | --- |
| Print palette | Mapped surface colors for four-filament printing, chosen by the Multicolor export |
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
No double taps: a second press on the same panel at about the same spot within 100 ms is ignored, so a jittery tap
that opens a menu can't also choose the option that appears under your finger or laser dot (`static/vr-press.js`).

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

**Voice commands.** While you are in VR the microphone stays open for these commands. A cheat sheet of them lies on
the back of your left forearm, a hand's width up from the watch: turn that side of your arm toward you, as if checking
the watch, and it shows the commands for the mode you are in (and whether voice is on).


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

## Model view and export

**Export model** (left sidebar) opens the model view: the 3D model fills the window, with **◀ Map selection** to
go back and two exports beside it. The size box sets the model's longest side in millimeters.

| Export | File | What it is |
| --- | --- | --- |
| **Standard 3D model** | STL | One closed solid in a single filament, for any printer |
| **Multicolor** | 3MF | The Print palette's mapped surface colors, plus the map layers that are on, as separate color parts for up to four filaments |

Multicolor switches the model to the Print palette (its colors show in the preview). When the surface colors and
the map layers that are on need more than four filaments, the button says how many and stays off until some layers
are turned off. If loading the surface colors fails, the model view says so; click Multicolor again to retry.

**Following the headset.** When a model is generated in VR, the computer's page (following the headset, the
default) opens the same model in its model view, ready to export; when the headset goes back to the map, the model
view closes. **◀ Map selection** closes it on the computer only; the headset's later updates don't reopen it for the
same model.

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

**Faster features.** A new area's features take Overpass about 30–45 seconds, so the app avoids asking twice:

- Each download covers 20% more on every side (at least 250 m), rounded outward to a 0.005° grid, and is kept for
  seven days. A later area inside a saved download (the same place framed a little differently, as happens moving the
  map by hand in VR) is cut from it at once instead of downloading again.
- In VR, once the map rests for a moment, the server starts downloading the framed area's features (and buildings,
  when on) before you press Generate. Only the latest framing waits its turn.
- Overpass runs two queries at a time for each computer and refuses more, so the app's map features, buildings,
  and print colors take turns in two slots. A refusal for being busy waits a moment and asks again; when the main
  server stays busy or can't be reached, two public mirrors are tried. A server set with `TERRAIN_OVERPASS_URL` is
  used alone.

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

The model view's **Multicolor** export uses the Print palette: Dark foliage, Light foliage, Dirt, Snow, Water,
and Buildings, each a filament color. Matching colors share one filament, and at most four fit a multicolor print.

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
`node tests/browser-selection-shapes.cjs` checks circle/oval border dragging, rotation, generation, and that the model view's STL keeps an oval footprint. The fixture server uses synthetic elevations for round selections.
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

## Interface defaults and favorite landscape parameters

The **ft / m** switch in **Follow the ridgeline** sets the display units for the
whole page and is remembered in this browser. Feet is the default: elevations,
selection dimensions, and grid spacing show feet, and profile distances miles.
In meters, the same readouts show meters and kilometers. Profile heights are
always unexaggerated heights above sea level.
Print dimensions stay in millimeters, while raw elevation data and GLB retain
their documented metric units.

Adjust the terrain controls in the left sidebar, the map features in **Map layers**,
then click
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
