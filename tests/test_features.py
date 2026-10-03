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
from terrain_app.features import FeatureClient, LAYER_NAMES, building_height, classify, layer_options, overpass_query, paths, prepare_features, to_selection
from terrain_app.server import create_app, load_example
from terrain_app.services import ZipClient, ZipLookupError, response_json


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
    extent = bounds.geographic_extent
    bbox = ",".join(f"{value:.8f}" for value in (extent.south, extent.west, extent.north, extent.east))
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
    assert queries == [building_query(bounds), overpass_query(bounds)]  # separately cached

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
