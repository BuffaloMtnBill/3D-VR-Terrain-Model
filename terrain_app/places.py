"""Named selection areas shared by the map UI and bundled terrain loader.

Each entry needs a name, a label for the Famous landscapes list, and bounds. It may also
carry what Current box parameters > Copy parameters produces in the app:

    "zoom": the map zoom to show the area at (never closer than the area fits), and
    "settings": {"palette": ..., "controls": {...}}, the right-hand rendering settings
        (map features, colors, detail, 3D buildings, print palette) applied on selection.

Entries without settings leave the current rendering settings unchanged.
"""

DEFAULT_PLACE = "roan"
PRESETS = {
    "roan": {"name": "Roan Mountain", "label": "Roan Mountain, USA",
             "bounds": {"south": 36.080, "west": -82.165, "north": 36.145, "east": -82.055}},
    "rainier": {"name": "Mount Rainier", "label": "Mount Rainier, USA",
                "bounds": {"south": 46.775, "west": -121.865, "north": 46.930, "east": -121.645}},
    "yosemite": {"name": "Yosemite Valley", "label": "Yosemite Valley, USA",
                 "bounds": {"south": 37.695, "west": -119.665, "north": 37.785, "east": -119.525}},
    "fuji": {"name": "Mount Fuji", "label": "Mount Fuji, Japan",
             "bounds": {"south": 35.29, "west": 138.66, "north": 35.43, "east": 138.81}},
    "canyon": {"name": "Grand Canyon", "label": "Grand Canyon, USA",
               "bounds": {"south": 36.015, "west": -112.23, "north": 36.15, "east": -112.045}},
    "alps": {"name": "Chamonix", "label": "Chamonix, French Alps",
             "bounds": {"south": 45.82, "west": 6.76, "north": 45.965, "east": 6.995}},
}
