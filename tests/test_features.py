from io import BytesIO
import json
from threading import Event
import time

import numpy as np
from PIL import Image
import pytest
import requests
from shapely.geometry import Point, Polygon

from terrain_app.elevation import Bounds, selection_coordinates
from terrain_app.features import FeatureClient, LAYER_NAMES, building_height, classify, download_extent, layer_options, overpass_query, paths, prepare_features, to_selection
from terrain_app.server import create_app, load_example
from terrain_app.features import OVERPASS_URL as OVERPASS_DEFAULT
from terrain_app.services import ZipClient, ZipLookupError, response_json
from terrain_app.hydrography import HydrographyClient, prepare_water


@pytest.fixture
def application(tmp_path):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    yield app
    app.extensions["terrain"]["executor"].shutdown(wait=True)


class JsonResponse:
    def __init__(self, value, status=200):
        self.content = json.dumps(value).encode()
        self.status_code = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def iter_content(self, size):
        for offset in range(0, len(self.content), size):
            yield self.content[offset:offset+size]


def hydro_line(identifier=1, label="Channel Line", order=1):
    return {"attributes": {"OBJECTID": identifier, "featuretypelabel": label, "gnisidlabel": "Test Creek", "streamorder": order},
            "geometry": {"paths": [[[-.005, .005, 200], [.015, .005, 150]]]}}


def test_usgs_clips_creeks_and_excludes_artificial_paths():
    bounds = Bounds(0, 0, .01, .01)
    result = prepare_water({50: [hydro_line(), hydro_line(2, "Artificial Path"), hydro_line(3, order=4)]}, bounds)
    assert [feature["kind"] for feature in result["water"]] == ["stream", "river"]
    assert result["water"][0]["lines"] == [[[0, .5], [1, .5]]]
    assert result["water"][0]["name"] == "Test Creek"


def test_usgs_preserves_legacy_channel_labels_and_headwater_drainage():
    data = {50: [hydro_line(1, 'River'), hydro_line(2, 'Canal'), hydro_line(3, 'Drainageway'), hydro_line(4, 'Surface Connector')]}
    result = prepare_water(data, Bounds(0, 0, .01, .01))
    assert [feature['kind'] for feature in result['water']] == ['stream', 'canal', 'drain']


@pytest.mark.parametrize("rotation", [0, 35])
def test_usgs_waterbody_preserves_islands_and_full_area(rotation):
    bounds = Bounds(0, 0, .01, .01, rotation)
    # Same winding and reversed input ordering must still identify the island.
    outer = [[-.005,-.005],[.015,-.005],[.015,.015],[-.005,.015],[-.005,-.005]]
    island = [[.004,.004],[.006,.004],[.006,.006],[.004,.006],[.004,.004]]
    record = {"attributes": {"OBJECTID": 5, "featuretypelabel": "Lake"}, "geometry": {"rings": [island, outer]}}
    feature = prepare_water({60: [record]}, bounds)["water"][0]
    polygon = feature["polygons"][0]
    assert len(polygon["holes"]) == 1
    assert not Polygon(polygon["outer"], polygon["holes"]).contains(Point(.5, .5))
    assert feature["area_m2"] == pytest.approx(3.96*np.prod(bounds.dimensions), abs=.02)


def test_usgs_paginates_and_caches_complete_results(tmp_path, monkeypatch):
    bounds = Bounds(0, 0, .01, .01, 25)
    calls = []
    def get(url, **options):
        params = options["params"]
        calls.append((url, params.copy()))
        if '/60/' in url:
            return JsonResponse({"features": []})
        offset = params["resultOffset"]
        return JsonResponse({"features": [hydro_line(offset+1)], "exceededTransferLimit": offset == 0})
    monkeypatch.setattr("terrain_app.hydrography.requests.get", get)
    provider = HydrographyClient(tmp_path)
    result = provider.fetch(bounds)
    assert len(result["water"]) == 2
    assert provider.fetch(bounds) == result
    assert [params["resultOffset"] for _, params in calls] == [0, 1, 0]
    assert calls[0][1]["geometry"] == ','.join(str(v) for v in (bounds.geographic_extent.west, bounds.geographic_extent.south, bounds.geographic_extent.east, bounds.geographic_extent.north))
    assert calls[0][1]["outSR"] == 4326


@pytest.mark.parametrize("page", [{"error": {"code": 500}}, {"features": [], "exceededTransferLimit": True}])
def test_usgs_incomplete_download_is_not_cached(tmp_path, monkeypatch, page):
    monkeypatch.setattr("terrain_app.hydrography.requests.get", lambda *a, **kw: JsonResponse(page))
    with pytest.raises(ValueError):
        HydrographyClient(tmp_path).fetch(Bounds(0, 0, .01, .01))
    assert not list(tmp_path.glob('*.json'))


def test_usgs_water_jobs_are_independent_and_export_uses_selected_source(application, monkeypatch):
    bounds = load_example().bounds
    extension = application.extensions["terrain"]
    data = {"water": [{"id": "usgs/50/1", "kind": "stream", "lines": [[[0,.5],[1,.5]]], "polygons": []}], "source": "USGS"}
    monkeypatch.setattr(extension["hydrography"], "fetch", lambda b: data)
    client = application.test_client()
    query = '/api/features/example?layer=water&source=usgs'
    assert client.post(query, json={}).status_code == 202
    for _ in range(100):
        result = client.get(query).get_json()
        if result['state'] == 'ready':
            break
        time.sleep(.01)
    assert result['water'] == data['water']
    assert client.post(query, json={}).status_code == 200
    assert not extension['feature_jobs']
    assert client.post('/api/features/example?layer=water&source=bad', json={}).status_code == 400
    styles = {"water": {"enabled": True, "color": "#123456", "source": "usgs", "detail": 100}}
    response = client.post('/api/export/example', json={"format": "metadata", "feature_layers": styles})
    assert response.get_json()['feature_layers']['water']['source'] == 'usgs'
    osm = prepare_features({"elements": []}, bounds)
    osm['layers']['water'] = [{"id": "osm/creek", "kind": "stream"}, {"id": "coastline/sea", "kind": "sea"}]
    extension['feature_jobs']['example'] = {"state": "ready", "data": osm}
    terrain = load_example()
    rows, columns = terrain.elevations.shape
    extension['cover_jobs']['example'] = {"state": "ready", "data": {"face_classes": [0]*(2*(rows-1)*(columns-1))}}
    captured = []
    def export(*args):
        captured.append(args[-1])
        return BytesIO(b'test'), 'application/octet-stream', 'terrain.3mf'
    monkeypatch.setattr('terrain_app.server.export_3mf', export)
    payload = {"format": "3mf", "feature_layers": styles, "print_palette": dict.fromkeys(('dark_foliage','light_foliage','dirt','snow','water','buildings'), '#123456')}
    assert client.post('/api/export/example', json=payload).status_code == 200
    assert [feature['id'] for feature in captured[0]['layers']['water']] == ['coastline/sea', 'usgs/50/1']
    del extension['water_jobs']['example']
    assert client.post('/api/export/example', json=payload).status_code == 400


def osm_way(identifier, tags, points):
    return {"type": "way", "id": identifier, "tags": tags,
            "geometry": [None if point is None else {"lon": point[0], "lat": point[1]} for point in points]}


def test_zip_plus_four_preserves_leading_zero_and_reuses_five_digit_cache(tmp_path, monkeypatch):
    calls = []
    def get(url, **options):
        calls.append(url)
        assert options["stream"] and options["timeout"] == (8, 15)
        return JsonResponse({"places": [{"latitude": "40.8154", "longitude": "-73.0451", "place name": "Holtsville", "state abbreviation": "NY"}]})
    monkeypatch.setattr("terrain_app.services.requests.get", get)
    client = ZipClient(tmp_path)
    location = client.lookup("00501-1234")
    assert location["zip"] == "00501" and location["city"] == "Holtsville"
    assert location["latitude"] == 40.8154 and location["longitude"] == -73.0451
    assert client.lookup("00501") == location
    assert calls == ["https://api.zippopotam.us/us/00501"]


@pytest.mark.parametrize("value", ["1234", "123456", "12abc", "37687-123", "37687/1234", 37687])
def test_invalid_zip_is_rejected_before_network_access(tmp_path, value, monkeypatch):
    monkeypatch.setattr("terrain_app.services.requests.get", lambda *_args, **_kwargs: pytest.fail("Unexpected network request"))
    with pytest.raises(ZipLookupError) as error:
        ZipClient(tmp_path).lookup(value)
    assert error.value.status == 400


@pytest.mark.parametrize("response,status", [(JsonResponse({}, 404), 404), (JsonResponse({}, 503), 502),
                                          (JsonResponse({"places": []}), 502),
                                          (JsonResponse({"places": [{"latitude": "NaN", "longitude": 0}]}), 502)])
def test_zip_service_errors_are_explicit(tmp_path, monkeypatch, response, status):
    monkeypatch.setattr("terrain_app.services.requests.get", lambda *_args, **_kwargs: response)
    with pytest.raises(ZipLookupError) as error:
        ZipClient(tmp_path).lookup("37687")
    assert error.value.status == status
    assert not list(tmp_path.glob("*.json"))


def test_zip_http_navigation_and_error_status(application, monkeypatch):
    def lookup(zipcode):
        if zipcode == "00000":
            raise ZipLookupError("ZIP not found", 404)
        return {"zip": zipcode[:5], "latitude": 36.1773, "longitude": -82.081, "city": "Roan Mountain", "state": "TN"}
    monkeypatch.setattr(application.extensions["terrain"]["zip"], "lookup", lookup)
    client = application.test_client()
    assert client.get("/api/location/zip/37687-1234").get_json()["zip"] == "37687"
    response = client.get("/api/location/zip/00000")
    assert response.status_code == 404 and response.get_json()["error"] == "ZIP not found"


def test_json_downloads_are_bounded_and_require_an_object():
    with pytest.raises(ValueError, match="too much data"):
        response_json(JsonResponse({"data": "x"*100}), 20)
    with pytest.raises(ValueError, match="invalid response"):
        response_json(JsonResponse([]), 100)


def test_osm_tags_classify_features_without_proposed_roads_or_abandoned_rails():
    assert classify({"highway": "residential"}) == ["roads"]
    assert classify({"railway": "rail"}) == ["railways"]
    assert classify({"boundary": "administrative", "admin_level": "6"}) == ["borders"]
    assert classify({"boundary": "administrative", "admin_level": "8"}) == ["cities"]
    assert classify({"natural": "water"}) == ["water"]
    assert classify({"boundary": "national_park"}) == ["parks"]
    assert classify({"highway": "proposed", "railway": "abandoned"}) == []
    assert classify({"boundary": "administrative", "admin_level": "unknown"}) == []
    assert classify({"building": "house"}) == ["buildings"]
    assert classify({"building": "no"}) == []


def test_building_footprints_and_heights_are_preserved():
    bounds = Bounds(0, 0, .01, .01)
    building = osm_way(7, {"building": "house", "height": "12 m"}, [(.002, .002), (.004, .002), (.004, .004), (.002, .004), (.002, .002)])
    result = prepare_features({"elements": [building]}, bounds)
    feature = result["layers"]["buildings"][0]
    assert len(feature["polygons"]) == 1
    assert feature["height_m"] == 12 and feature["height_source"] == "height"
    assert building_height({"building:levels": "3"}) == (9, "building:levels")
    assert building_height({"height": "NaN"}) == (6, "assumed")


def test_missing_geometry_points_split_paths_instead_of_drawing_artificial_connections():
    points = osm_way(1, {}, [(0, 0), (1, 1), None, (2, 2), (3, 3)])["geometry"]
    assert paths(points) == [[[0, 0], [1, 1]], [[2, 2], [3, 3]]]


@pytest.mark.parametrize("angle", [0, 30, 90, -135])
def test_feature_coordinates_match_the_rotated_terrain_grid(angle):
    bounds = Bounds(36.080, -82.165, 36.145, -82.055, angle)
    expected_u, expected_v = np.meshgrid(np.linspace(0, 1, 9), np.linspace(0, 1, 7))
    longitude, latitude = selection_coordinates(bounds, expected_u, expected_v)
    coordinates = np.column_stack((longitude.ravel(), latitude.ravel()))
    np.testing.assert_allclose(to_selection(bounds, coordinates), np.column_stack((expected_u.ravel(), expected_v.ravel())), atol=1e-11)


def test_lines_are_clipped_to_the_box_and_disconnected_segments_stay_separate():
    bounds = Bounds(0, 0, .01, .01)
    road = osm_way(1, {"highway": "residential"}, [(-.005, .005), (.015, .005), None, (.002, .008), (.004, .008)])
    outside = osm_way(2, {"highway": "residential"}, [(.015, .005), (.025, .005)])
    result = prepare_features({"elements": [road, outside]}, bounds)
    assert result["counts"]["roads"] == 1
    assert result["layers"]["roads"][0]["lines"] == [[[0, .5], [1, .5]], [[.2, .2], [.4, .2]]]


def test_water_relation_assembles_reversed_segments_and_preserves_islands():
    bounds = Bounds(0, 0, .01, .01)
    relation = {"type": "relation", "id": 1, "tags": {"natural": "water"}, "members": []}
    rings = [("outer", [(.001, .001), (.009, .001), (.009, .009), (.001, .009), (.001, .001)]),
             ("inner", [(.004, .004), (.006, .004), (.006, .006), (.004, .006), (.004, .004)])]
    for role, ring in rings:
        for start, end in zip(ring[:-1], ring[1:]):
            member = osm_way(10, {}, [end, start])
            member["role"] = role
            relation["members"].append(member)
    result = prepare_features({"elements": [relation]}, bounds)
    polygon = result["layers"]["water"][0]["polygons"][0]
    assert len(polygon["holes"]) == 1
    assert Polygon(polygon["outer"], polygon["holes"]).area == pytest.approx(.60)


def test_full_water_geometry_takes_precedence_over_bounded_duplicate():
    bounds = Bounds(0, 0, .01, .01)
    closed = osm_way(1, {"natural": "water"}, [(-.005, -.005), (.015, -.005), (.015, .015), (-.005, .015), (-.005, -.005)])
    clipped = {**closed, "geometry": [None, None]}
    result = prepare_features({"elements": [clipped, closed]}, bounds)
    assert result["counts"]["water"] == 1
    assert Polygon(result["layers"]["water"][0]["polygons"][0]["outer"]).area == 1
    assert result["layers"]["water"][0]["area_m2"] == pytest.approx(4*np.prod(bounds.dimensions), abs=.01)


def test_road_and_water_classification_supports_detail_filtering():
    bounds = Bounds(0, 0, .01, .01)
    features = [osm_way(1, {"highway": "primary"}, [(0, .002), (.01, .002)]),
                osm_way(2, {"waterway": "stream"}, [(0, .004), (.01, .004)]),
                osm_way(3, {"waterway": "river"}, [(0, .006), (.01, .006)])]
    result = prepare_features({"elements": features}, bounds)
    assert result["layers"]["roads"][0]["kind"] == "primary"
    assert {feature["kind"] for feature in result["layers"]["water"]} == {"stream", "river"}
    assert result["schema_version"] == 6


@pytest.mark.parametrize("detail", [-1, 101, True, "50", float("nan")])
def test_invalid_feature_detail_is_rejected(application, detail):
    styles = {"roads": {"enabled": True, "color": "#123456", "detail": detail}}
    with pytest.raises(ValueError, match="detail"):
        layer_options(styles)
    assert application.test_client().post("/api/export/example", json={"format": "metadata", "feature_layers": styles}).status_code == 400


def test_feature_detail_choices_survive_export_metadata(application):
    styles = {name: {"enabled": True, "color": "#123456", "detail": detail} for name, detail in (("roads", 25), ("water", 40))}
    response = application.test_client().post("/api/export/example", json={"format": "metadata", "feature_layers": styles})
    assert response.get_json()["feature_layers"] == styles


def test_incomplete_overpass_response_is_not_cached_as_missing_features(tmp_path, monkeypatch):
    monkeypatch.setattr("terrain_app.features.requests.post", lambda *_args, **_kwargs: JsonResponse({"elements": [], "remark": "Query timed out"}))
    with pytest.raises(ValueError, match="did not finish"):
        FeatureClient(tmp_path).fetch(load_example().bounds)
    assert not list(tmp_path.glob("*.json"))


def test_feature_fetch_uses_rotated_envelope_and_reuses_cache(tmp_path, monkeypatch):
    bounds = Bounds(36.080, -82.165, 36.145, -82.055, 30)
    calls = []
    def post(url, **options):
        calls.append(options["data"]["data"])
        assert options["stream"] and options["timeout"] == (8, 75)
        return JsonResponse({"elements": []})
    monkeypatch.setattr("terrain_app.features.requests.post", post)
    client = FeatureClient(tmp_path)
    result = client.fetch(bounds)
    assert client.fetch(bounds) == result
    assert len(calls) == 1 and result["counts"] == dict.fromkeys(LAYER_NAMES, 0)
    # The download covers the rotated area's envelope, padded and rounded outward so nearby areas can share it.
    extent, area = bounds.geographic_extent, download_extent(bounds.geographic_extent)
    assert area.south < extent.south and area.west < extent.west and area.north > extent.north and area.east > extent.east
    bbox = ",".join(f"{value:.8f}" for value in (area.south, area.west, area.north, area.east))
    assert f"out geom({bbox})" in calls[0]
    assert overpass_query(bounds).endswith("out geom qt;")


def test_oversized_feature_area_is_rejected_before_download(tmp_path, monkeypatch):
    monkeypatch.setattr("terrain_app.features.requests.post", lambda *_args, **_kwargs: pytest.fail("Unexpected network request"))
    with pytest.raises(ValueError, match="50 km"):
        FeatureClient(tmp_path).fetch(Bounds(0, 0, 1, 1))


def wait_for_features(client, identifier):
    for _ in range(100):
        result = client.get(f"/api/features/{identifier}").get_json()
        if result["state"] in ("ready", "error"):
            return result
        time.sleep(.01)
    pytest.fail("Feature job did not finish")


def test_feature_jobs_deduplicate_and_use_model_bounds(application, monkeypatch):
    started, release = Event(), Event()
    calls = []
    terrain = load_example()
    terrain.bounds = Bounds(**terrain.bounds.to_dict(), rotation_deg=30)
    application.extensions["terrain"]["jobs"]["rotated"] = {"state": "ready", "terrain": terrain, "accessed": time.monotonic()}
    def fetch(bounds):
        calls.append(bounds)
        started.set()
        assert release.wait(2)
        return prepare_features({"elements": []}, bounds)
    monkeypatch.setattr(application.extensions["terrain"]["features"], "fetch", fetch)
    client = application.test_client()
    assert client.get("/api/features/rotated").status_code == 404
    try:
        assert client.post("/api/features/rotated", json={}).status_code == 202
        assert started.wait(2)
        assert client.post("/api/features/rotated", json={}).status_code == 202
    finally:
        release.set()
    result = wait_for_features(client, "rotated")
    assert result["state"] == "ready" and result["bounds"]["rotation_deg"] == 30
    assert calls == [terrain.bounds]
    assert client.post("/api/features/rotated", json={}).status_code == 200
    assert client.post("/api/features/missing", json={}).status_code == 404
    assert client.post("/api/features/rotated", json={}, headers={"Origin": "https://example.com"}).status_code == 403


def test_failed_feature_job_can_be_retried(application, monkeypatch):
    provider = application.extensions["terrain"]["features"]
    def fail(_bounds):
        raise ValueError("The service is busy")
    monkeypatch.setattr(provider, "fetch", fail)
    client = application.test_client()
    client.post("/api/features/example", json={})
    result = wait_for_features(client, "example")
    assert result["state"] == "error" and result["message"] == "The service is busy"
    monkeypatch.setattr(provider, "fetch", lambda bounds: prepare_features({"elements": []}, bounds))
    assert client.post("/api/features/example", json={}).status_code == 202
    assert wait_for_features(client, "example")["state"] == "ready"


@pytest.mark.parametrize("options", [{"airports": {"enabled": True, "color": "#123456"}},
                                     {"roads": {"enabled": "true", "color": "#123456"}},
                                     {"water": {"enabled": True, "color": "red"}}])
def test_feature_export_styles_are_validated(application, options):
    with pytest.raises(ValueError):
        layer_options(options)
    assert application.test_client().post("/api/export/example", json={"format": "metadata", "feature_layers": options}).status_code == 400


@pytest.mark.parametrize("format", ["metadata", "png", "obj"])
def test_feature_choices_and_colors_are_embedded_in_export_metadata(application, format):
    styles = {"roads": {"enabled": True, "color": "#FEDABC"}, "water": {"enabled": False, "color": "#619ea5"}}
    response = application.test_client().post("/api/export/example", json={"format": format, "feature_layers": styles})
    assert response.status_code == 200
    if format == "metadata":
        metadata = response.get_json()
    elif format == "png":
        image = Image.open(BytesIO(response.data))
        metadata = json.loads(image.info["terrain_metadata"])
    else:
        line = next(line for line in response.get_data(as_text=True).splitlines() if line.startswith("# Metadata: "))
        metadata = json.loads(line.removeprefix("# Metadata: "))
    assert metadata["feature_layers"] == layer_options(styles)


def test_appalachian_trail_relations_and_named_ways_are_clipped():
    bounds = Bounds(0, 0, .01, .01)
    assert classify({"type": "route", "route": "hiking", "ref": "AT"}) == ["at"]
    assert classify({"route": "hiking", "name": "Appalachian National Scenic Trail (Tennessee)"}) == ["at"]
    assert classify({"highway": "path", "name": "Appalachian Trail"}) == ["at"]
    assert classify({"highway": "path", "name": "Appalachian Trail Approach"}) == ["trails"]
    assert classify({"route": "hiking", "ref": "OTHER"}) == []
    assert classify({"route": "bus", "ref": "AT"}) == []
    relation = {"type": "relation", "id": 123, "tags": {"type": "route", "route": "hiking", "ref": "AT"},
                "members": [{"type": "way", "geometry": [{"lon": -.01, "lat": .005}, {"lon": .02, "lat": .005}]}]}
    result = prepare_features({"elements": [relation]}, bounds)
    assert result["layers"]["at"][0]["lines"] == [[[0, .5], [1, .5]]]
    assert result["counts"]["at"] == 1 and result["counts"]["roads"] == 0
    query = overpass_query(bounds)
    assert 'relation["route"~"^(hiking|foot)$"]["ref"~"^AT$",i]' in query
    assert layer_options({"at": {"enabled": True, "color": "#F0EAD6"}})["at"]["color"] == "#f0ead6"


def test_place_search_returns_best_match_and_caches_it(tmp_path, monkeypatch):
    from terrain_app.services import PlaceClient
    calls = []
    def get(url, **options):
        calls.append(options["params"])
        assert options["headers"]["User-Agent"] and options["stream"]
        return JsonResponse([{"lat": "35.5951", "lon": "-82.5515", "display_name": "Asheville, Buncombe County, North Carolina, United States",
                              "boundingbox": ["35.4219", "35.6560", "-82.6711", "-82.4590"]}])
    monkeypatch.setattr("terrain_app.services.requests.get", get)
    client = PlaceClient(tmp_path)
    place = client.lookup("  Asheville,   NC ")
    assert place["latitude"] == 35.5951 and place["longitude"] == -82.5515 and place["name"].startswith("Asheville")
    assert place["bounds"] == {"south": 35.4219, "west": -82.6711, "north": 35.6560, "east": -82.4590}
    assert client.lookup("asheville, nc") == place
    assert calls == [{"q": "Asheville, NC", "format": "jsonv2", "limit": 1}]


def test_place_search_errors_are_explicit(tmp_path, monkeypatch, application):
    from terrain_app.services import PlaceClient, PlaceLookupError
    client = PlaceClient(tmp_path)
    with pytest.raises(PlaceLookupError):
        client.lookup(" ")
    monkeypatch.setattr("terrain_app.services.requests.get", lambda *_a, **_k: JsonResponse([]))
    with pytest.raises(PlaceLookupError) as missing:
        client.lookup("nowhere at all")
    assert missing.value.status == 404
    client.last_request = 0
    monkeypatch.setattr("terrain_app.services.requests.get", lambda *_a, **_k: JsonResponse({}, 503))
    with pytest.raises(PlaceLookupError) as offline:
        client.lookup("Asheville")
    assert offline.value.status == 502 and not list(tmp_path.iterdir())
    monkeypatch.setattr(application.extensions["terrain"]["places"], "lookup", lambda query: {"query": query, "name": "Asheville"})
    http = application.test_client()
    assert http.get("/api/location/search?q=Asheville%2C%20NC").get_json() == {"query": "Asheville, NC", "name": "Asheville"}


def test_other_trails_exclude_sidewalks_and_appalachian_trail_members():
    bounds = Bounds(0, 0, .01, .01)
    assert classify({"highway": "bridleway"}) == ["trails"]
    assert classify({"highway": "footway", "footway": "sidewalk"}) == []
    assert classify({"highway": "track"}) == ["roads"]
    line = [(0, .004), (.01, .004)]
    relation = {"type": "relation", "id": 9, "tags": {"route": "hiking", "ref": "AT"},
                "members": [{"type": "way", "ref": 1, "geometry": [{"lon": x, "lat": y} for x, y in line]}]}
    result = prepare_features({"elements": [osm_way(1, {"highway": "path"}, line), relation,
                                            osm_way(2, {"highway": "path", "name": "Ridge Loop"}, [(0, .006), (.01, .006)])]}, bounds)
    assert [feature["id"] for feature in result["layers"]["trails"]] == ["way/2"]
    assert [feature["id"] for feature in result["layers"]["at"]] == ["relation/9"]
    assert 'way["highway"~"^(path|footway|bridleway)$"]' in overpass_query(bounds)


def test_building_dimensions_follow_simple_3d_building_tags():
    from terrain_app.buildings import building_dimensions
    plain = building_dimensions({"building": "yes"})
    assert (plain["height_m"], plain["height_source"], plain["roof_shape"], plain["roof_height_m"]) == (6, "assumed", "flat", 0)
    tower = building_dimensions({"building:levels": "4", "roof:levels": "1", "building:min_level": "2", "roof:shape": "Hipped", "roof:orientation": "across"})
    assert tower == {"height_m": 15, "height_source": "building:levels", "min_height_m": 6, "roof_shape": "hipped", "roof_height_m": 3, "roof_across": True}
    assert building_dimensions({"height": "10", "roof:shape": "gabled", "roof:height": "40"})["roof_height_m"] == 10
    assert building_dimensions({"height": "10", "min_height": "12"})["min_height_m"] == 0
    assert building_dimensions({"roof:shape": "skillion", "roof:direction": "SW"})["roof_direction_deg"] == 225
    assert building_dimensions({"roof:shape": "zigzag"})["roof_shape"] == "flat"


@pytest.mark.parametrize("shape,roof_volume", [("flat", 600), ("gabled", 300), ("pyramidal", 200), ("hipped", 250), ("skillion", 300)])
def test_roof_shapes_are_closed_solids_with_exact_volumes(shape, roof_volume):
    import manifold3d as mf
    from shapely.geometry import box
    from terrain_app.buildings import building_dimensions, polygon_solid
    dimensions = building_dimensions({"height": "9", "roof:shape": shape, "roof:height": "3"})
    solid = polygon_solid(box(0, 0, 20, 10), dimensions)
    assert solid.status() == mf.Error.NoError
    assert solid.volume() == pytest.approx(200*6+roof_volume)
    concave = polygon_solid(Polygon([(0, 0), (20, 0), (20, 8), (8, 8), (8, 20), (0, 20)]), dimensions)
    assert concave.status() == mf.Error.NoError and 256*6 < concave.volume() <= 256*9+1e-6


def test_building_parts_replace_their_outline_in_3d_mode():
    bounds = Bounds(0, 0, .01, .01)
    square = lambda a, b: [(a, a), (b, a), (b, b), (a, b), (a, a)]
    elements = [osm_way(1, {"building": "yes", "height": "30"}, square(.002, .008)),
                osm_way(2, {"building:part": "yes", "height": "10"}, square(.002, .005)),
                osm_way(3, {"building:part": "yes", "height": "30", "min_height": "10", "roof:shape": "pyramidal", "roof:height": "5"}, square(.003, .004)),
                osm_way(4, {"building": "house", "roof:shape": "gabled", "height": "8"}, [(.0085, .0085), (.011, .0085), (.011, .0095), (.0085, .0095), (.0085, .0085)]),
                osm_way(5, {"building": "garage"}, square(.0001, .0005))]
    buildings = {feature["id"]: feature for feature in prepare_features({"elements": elements}, bounds)["layers"]["buildings"]}
    assert buildings["way/1"]["has_parts"] and "mesh" not in buildings["way/1"]
    assert buildings["way/2"]["part"] and buildings["way/2"]["parent"] == "way/1"
    assert "mesh" not in buildings["way/5"] and "part" not in buildings["way/5"]
    spire = np.asarray(buildings["way/3"]["mesh"]["positions"]).reshape(-1, 3)
    assert spire[:, 2].min() == 10 and spire[:, 2].max() == 30
    house = np.asarray(buildings["way/4"]["mesh"]["positions"]).reshape(-1, 3)
    assert np.isfinite(house).all() and house[:, :2].min() >= 0 and house[:, 0].max() == 1  # clipped at the frame
    assert max(buildings["way/4"]["mesh"]["indices"]) == len(house)-1
    assert layer_options({"buildings": {"enabled": True, "color": "#FFFFFF", "detailed": True}})["buildings"]["detailed"] is True
    for bad in ({"roads": {"enabled": True, "color": "#ffffff", "detailed": True}}, {"buildings": {"enabled": True, "color": "#ffffff", "detailed": 1}}):
        with pytest.raises(ValueError):
            layer_options(bad)


def test_buildings_download_separately_from_other_layers(tmp_path, monkeypatch, application):
    from terrain_app.features import building_query
    bounds = Bounds(0, 0, .01, .01)
    assert "building" not in overpass_query(bounds)
    assert 'wr["building:part"]' in building_query(bounds) and "highway" not in building_query(bounds)
    queries = []
    def post(url, data, **_options):
        queries.append(data["data"])
        return JsonResponse({"elements": [osm_way(1, {"building": "yes"}, [(.002, .002), (.004, .002), (.004, .004), (.002, .002)])]})
    monkeypatch.setattr("terrain_app.features.requests.post", post)
    client = FeatureClient(tmp_path)
    assert client.fetch_buildings(bounds)["counts"]["buildings"] == 1
    client.fetch_buildings(bounds)
    client.fetch(bounds)
    area = download_extent(bounds.geographic_extent)
    assert queries == [building_query(area), overpass_query(area)]  # separately cached

    provider, calls = application.extensions["terrain"]["features"], []
    monkeypatch.setattr(provider, "fetch", lambda bounds: calls.append("other") or prepare_features({"elements": []}, bounds))
    monkeypatch.setattr(provider, "fetch_buildings", lambda bounds: calls.append("buildings") or prepare_features({"elements": []}, bounds))
    http = application.test_client()
    assert http.post("/api/features/example", json={}).status_code == 202
    assert wait_for_features(http, "example")["state"] == "ready"
    assert calls == ["other"] and http.get("/api/features/example?layer=buildings").status_code == 404
    assert http.post("/api/features/example?layer=buildings", json={}).status_code == 202
    for _ in range(100):
        if http.get("/api/features/example?layer=buildings").get_json()["state"] == "ready":
            break
        time.sleep(.01)
    assert calls == ["other", "buildings"]
    assert http.post("/api/features/example?layer=roads", json={}).status_code == 400


def test_feature_limits_allow_forty_thousand_elements_and_two_hundred_thousand_points():
    from terrain_app.features import building_query
    bounds = Bounds(0, 0, .01, .01)
    assert prepare_features({"elements": [{}]*40_000}, bounds)["counts"]["roads"] == 0
    with pytest.raises(ValueError, match="too many map features"):
        prepare_features({"elements": [{}]*40_001}, bounds)
    line = [(.001+.008*index/99_999, .005) for index in range(100_000)]
    roads = [osm_way(1, {"highway": "primary"}, line), osm_way(2, {"highway": "primary"}, line)]
    assert prepare_features({"elements": roads}, bounds)["counts"]["roads"] == 2
    with pytest.raises(ValueError, match="too detailed"):
        prepare_features({"elements": roads+[osm_way(3, {"highway": "primary"}, line[:2])]}, bounds)
    for query in (overpass_query(bounds), building_query(bounds)):
        assert query.startswith("[out:json][timeout:60][maxsize:134217728];")


def test_coastlines_turn_open_sea_into_water():
    from terrain_app.features import sea_geometry
    from terrain_app.landcover import prepare_cover
    bounds = Bounds(0, 0, .01, .01)
    # A coastline running north through the middle: land on its left (west), sea on its right (east).
    coast = osm_way(1, {"natural": "coastline"}, [(.005, -.002), (.005, .012)])
    island = osm_way(2, {"natural": "coastline"}, [(.007, .004), (.008, .004), (.008, .006), (.007, .006), (.007, .004)])
    result = prepare_features({"elements": [coast, island]}, bounds)
    sea = result["layers"]["water"][0]
    assert (sea["id"], sea["kind"]) == ("coastline/sea", "sea") and result["counts"]["water"] == 1
    shape = Polygon(sea["polygons"][0]["outer"], sea["polygons"][0]["holes"])
    assert shape.area == pytest.approx(.5-.1*.2, abs=1e-6)  # the eastern half, minus the island
    assert shape.contains(Point(.9, .9)) and not shape.contains(Point(.1, .5)) and not shape.contains(Point(.75, .5))
    assert sea["area_m2"] == pytest.approx(shape.area*np.prod(bounds.dimensions), rel=1e-6)
    rotated = Bounds(0, 0, .01, .01, 90)
    turned = prepare_features({"elements": [coast]}, rotated)["layers"]["water"][0]
    quarter = Polygon(turned["polygons"][0]["outer"])
    assert quarter.area == pytest.approx(.5, abs=1e-6) and quarter.contains(Point(.5, .1)) and not quarter.contains(Point(.5, .9))  # east is the top edge at 90°
    reversed_coast = osm_way(1, {"natural": "coastline"}, [(.005, .012), (.005, -.002)])
    west = Polygon(prepare_features({"elements": [reversed_coast]}, bounds)["layers"]["water"][0]["polygons"][0]["outer"])
    assert west.contains(Point(.1, .5)) and not west.contains(Point(.9, .5))
    assert sea_geometry([]).is_empty
    outside = osm_way(3, {"natural": "coastline"}, [(.02, 0), (.02, .01)])
    assert prepare_features({"elements": [outside]}, bounds)["counts"]["water"] == 0  # undecidable: left as land
    cover = prepare_cover({"elements": [coast, island]}, bounds)
    assert Polygon(cover["regions"]["water"][0]["outer"], cover["regions"]["water"][0]["holes"]).area == pytest.approx(.48, abs=1e-6)
    assert 'way["natural"="coastline"]' in overpass_query(bounds)


@pytest.mark.parametrize("platform,environment,expected", [
    ("win32", {"LOCALAPPDATA": "C:/Users/someone/AppData/Local"}, "C:/Users/someone/AppData/Local/TerrainStudio/Cache"),
    ("linux", {"XDG_CACHE_HOME": "/var/cache/someone"}, "/var/cache/someone/terrain-studio"),
    ("linux", {}, "~/.cache/terrain-studio"), ("darwin", {}, "~/Library/Caches/TerrainStudio")])
def test_cache_lives_in_the_per_user_cache_folder(monkeypatch, tmp_path, platform, environment, expected):
    from pathlib import Path
    from terrain_app import services
    monkeypatch.setattr(services.sys, "platform", platform)
    for name in ("LOCALAPPDATA", "XDG_CACHE_HOME", "TERRAIN_CACHE_DIR"):
        monkeypatch.delenv(name, raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    assert services.default_cache_dir() == Path(expected).expanduser()
    app = create_app({"TESTING": True})
    try:
        assert Path(app.config["CACHE_DIR"]) == services.default_cache_dir() / "elevation"
        assert Path.cwd() not in Path(app.config["CACHE_DIR"]).parents
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def test_single_flight_shares_one_download_between_callers():
    from threading import Thread
    from terrain_app.services import SingleFlight
    flight, started, release, calls, answers = SingleFlight(), Event(), Event(), [], []
    def work():
        calls.append(1)
        started.set()
        assert release.wait(2)
        return {"layers": "ready"}
    first = Thread(target=lambda: answers.append(flight.do("area", work)))
    first.start()
    assert started.wait(2)
    second = Thread(target=lambda: answers.append(flight.do("area", work)))
    second.start()
    time.sleep(.05)
    release.set()
    first.join(2)
    second.join(2)
    assert calls == [1] and answers == [{"layers": "ready"}] * 2
    # Once finished, the next call works again (it reads the cache in practice), and an error reaches every waiter.
    assert flight.do("area", lambda: "again") == "again"
    def fail():
        raise ValueError("busy")
    with pytest.raises(ValueError, match="busy"):
        flight.do("area", fail)


def test_generate_gives_the_chosen_map_features_a_head_start(application, monkeypatch):
    extension = application.extensions["terrain"]
    started = {"osm": Event(), "water": Event(), "buildings": Event()}
    terrain_done = Event()
    def elevation(bounds, *_args):
        assert terrain_done.wait(5)   # the features start while the terrain is still downloading
        return load_example()
    for client in extension["clients"].values():
        monkeypatch.setattr(client, "fetch", elevation)
    monkeypatch.setattr(extension["features"], "fetch", lambda bounds: started["osm"].set())
    monkeypatch.setattr(extension["features"], "fetch_buildings", lambda bounds: started["buildings"].set())
    monkeypatch.setattr(extension["hydrography"], "fetch", lambda bounds: started["water"].set())
    client = application.test_client()
    bounds = load_example().bounds.to_dict()
    try:
        response = client.post("/api/terrain", json={"bounds": bounds, "resolution": 64, "features": {"osm": True, "water": True, "buildings": False}})
        assert response.status_code == 202
        assert started["osm"].wait(2) and started["water"].wait(2)
        assert not started["buildings"].is_set(), "Only the layers the page shows are fetched"
        # A preview (the VR cut's surroundings) gets none.
        started["osm"].clear()
        client.post("/api/terrain", json={"bounds": bounds, "resolution": 64, "preview": True, "features": {"osm": True}})
        assert not started["osm"].wait(.3)
    finally:
        terrain_done.set()


def test_a_nearby_area_reuses_the_saved_download(tmp_path, monkeypatch):
    """Moving or zooming the frame a little (as in VR) cuts the new area from the padded download already saved."""
    calls = []
    road = osm_way(7, {"highway": "primary"}, [(-82.12, 36.10), (-82.10, 36.12)])
    far_road = osm_way(8, {"highway": "primary"}, [(-81.90, 36.40), (-81.89, 36.41)])
    far_road["bounds"] = {"minlat": 36.40, "minlon": -81.90, "maxlat": 36.41, "maxlon": -81.89}
    def post(url, **options):
        calls.append(options["data"]["data"])
        return JsonResponse({"elements": [road, far_road]})
    monkeypatch.setattr("terrain_app.features.requests.post", post)
    client = FeatureClient(tmp_path)
    first = client.fetch(Bounds(36.08, -82.16, 36.14, -82.06))
    moved = client.fetch(Bounds(36.085, -82.155, 36.142, -82.058))   # panned and zoomed a little
    assert len(calls) == 1, "The second area comes from the saved download"
    assert first["counts"]["roads"] == moved["counts"]["roads"] == 1, "Elements outside the area are left out"
    assert client.covered(Bounds(36.09, -82.15, 36.13, -82.07)) and not client.covered(Bounds(36.5, -81.5, 36.55, -81.45))
    client.fetch(Bounds(36.5, -81.5, 36.55, -81.45))
    assert len(calls) == 2, "An area outside every saved download is downloaded"


def test_overpass_busy_retries_then_mirrors(tmp_path, monkeypatch):
    from terrain_app import services
    monkeypatch.setattr(services, "OVERPASS_RETRY_S", 0)
    urls, answers = [], iter([429, 429, 503, 200])
    def post(url, **_options):
        urls.append(url)
        return JsonResponse({"elements": []}, next(answers))
    monkeypatch.setattr("terrain_app.features.requests.post", post)
    assert FeatureClient(tmp_path).fetch(Bounds(36.08, -82.16, 36.14, -82.06))["counts"]["roads"] == 0
    # Busy (429): the same server once more after a moment; still busy: each mirror in turn.
    assert urls == [OVERPASS_DEFAULT, OVERPASS_DEFAULT, *services.OVERPASS_MIRRORS]
    # A configured server (a test or private Overpass) is used alone: no mirrors.
    urls.clear()
    monkeypatch.setattr("terrain_app.features.requests.post", lambda url, **_options: urls.append(url) or JsonResponse({}, 503))
    with pytest.raises(ValueError, match="could not load"):
        FeatureClient(tmp_path / "own", url="http://localhost:9/overpass").fetch(Bounds(36.08, -82.16, 36.14, -82.06))
    assert urls == ["http://localhost:9/overpass"]


def test_overpass_runs_two_queries_at_a_time(tmp_path, monkeypatch):
    import threading
    running, most, lock = [0], [0], threading.Lock()
    def post(url, **_options):
        with lock:
            running[0] += 1;most[0] = max(most[0], running[0])
        time.sleep(.05)
        with lock:
            running[0] -= 1
        return JsonResponse({"elements": []})
    monkeypatch.setattr("terrain_app.features.requests.post", post)
    client = FeatureClient(tmp_path)
    areas = [Bounds(36+i, -82.16, 36.06+i, -82.06) for i in range(5)]
    threads = [threading.Thread(target=client.fetch, args=(area,)) for area in areas]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert most[0] == 2, f"Overpass allows each computer two queries at once ({most[0]} ran together)"


def test_framing_in_vr_starts_the_download(tmp_path, monkeypatch, application):
    calls = []
    monkeypatch.setattr("terrain_app.features.requests.post", lambda url, **options: calls.append(options["data"]["data"]) or JsonResponse({"elements": []}))
    client = application.extensions["terrain"]["features"]
    monkeypatch.setattr(client, "cache_dir", tmp_path)
    http, area = application.test_client(), {"south": 36.08, "west": -82.16, "north": 36.14, "east": -82.06}
    assert http.post("/api/features/prefetch", json={"bounds": area, "buildings": True}).get_json() == {"started": True}
    for _ in range(100):
        if client.covered(Bounds.from_dict(area), buildings=True):
            break
        time.sleep(.02)
    assert client.covered(Bounds.from_dict(area), buildings=True) and len(calls) == 2, "Map features and buildings both downloaded"
    assert http.post("/api/features/prefetch", json={"bounds": area}).get_json() == {"started": False}, "Already covered: nothing to do"
    assert http.post("/api/features/prefetch", json={"bounds": {"south": 0, "west": 0, "north": 1, "east": 1}}).get_json() == {"started": False}
    assert http.post("/api/features/prefetch", json={"bounds": {"south": 1}}).status_code == 400
