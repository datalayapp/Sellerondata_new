import numpy as np
import pytest

from .conftest import BOXES, VIEWS, detect, encode, scene


def dims_error(res: dict, truth) -> float:
    got = np.array([res["lengthCm"], res["widthCm"], res["heightCm"]])
    return float(np.max(np.abs(got - np.array(truth) / 10.0)))


def payload(sc, points, corners=None, intrinsics=None):
    body = {
        "imageSize": {"w": sc.image.shape[1], "h": sc.image.shape[0]},
        "marker": {"corners": np.asarray(sc.marker_corners if corners is None else corners).tolist()},
        "points": np.asarray(points).tolist(),
    }
    if intrinsics is not None:
        body["intrinsics"] = intrinsics
    return body


def true_intrinsics(sc):
    K = sc.K
    return {"fx": K[0, 0], "fy": K[1, 1], "cx": K[0, 2], "cy": K[1, 2], "source": "exif"}


@pytest.mark.parametrize("box", BOXES)
@pytest.mark.parametrize("view", VIEWS)
def test_exact_points_known_intrinsics(client, box, view):
    sc = scene(box, view)
    r = client.post("/solve", json=payload(sc, sc.points, intrinsics=true_intrinsics(sc)))
    assert r.status_code == 200, r.text
    res = r.json()
    assert dims_error(res, sc.box_mm) <= 0.5, (res, sc.box_mm)
    assert res["confidence"] >= 0.9


@pytest.mark.parametrize("box", BOXES)
@pytest.mark.parametrize("view", VIEWS)
def test_exact_points_estimated_intrinsics(client, box, view):
    sc = scene(box, view)
    res = client.post("/solve", json=payload(sc, sc.points)).json()
    assert dims_error(res, sc.box_mm) <= 0.5, (res, sc.box_mm)


@pytest.mark.parametrize("box", BOXES)
@pytest.mark.parametrize("view", VIEWS)
def test_detected_marker_and_noisy_points(client, box, view):
    """Full pipeline: /detect on the rendered photo, then /solve with +-2 px noise on every point."""
    sc = scene(box, view)
    det = detect(client, encode(sc.image)).json()
    assert det["ok"]
    rng = np.random.default_rng(int(box[0] + 7 * view[0] - 3 * view[1]))
    worst = 0.0
    for _ in range(8):
        noisy = sc.points + rng.uniform(-2.0, 2.0, sc.points.shape)
        body = payload(sc, noisy, corners=det["marker"]["corners"], intrinsics=det["intrinsics"])
        res = client.post("/solve", json=body).json()
        worst = max(worst, dims_error(res, sc.box_mm))
    assert worst <= 1.0, worst


def test_results_rounded_to_millimetre(client):
    sc = scene(BOXES[0], VIEWS[0])
    res = client.post("/solve", json=payload(sc, sc.points + 0.37)).json()
    for k in ("lengthCm", "widthCm", "heightCm"):
        assert round(res[k], 1) == res[k]
    assert 0.0 <= res["confidence"] <= 1.0


def test_inconsistent_points_lower_confidence(client):
    sc = scene(BOXES[0], VIEWS[0])
    good = client.post("/solve", json=payload(sc, sc.points)).json()
    bad_pts = sc.points.copy()
    bad_pts[3] += [40, 0]
    bad_pts[5] += [-35, 25]
    bad = client.post("/solve", json=payload(sc, bad_pts)).json()
    assert bad["confidence"] < good["confidence"] - 0.1


def test_points_above_horizon_rejected(client):
    sc = scene(BOXES[0], VIEWS[0])
    pts = sc.points.copy()
    pts[:3, 1] = -5000
    r = client.post("/solve", json=payload(sc, pts))
    assert r.status_code == 422
    assert "Noktalar" in r.json()["message"]


def test_wrong_point_count_rejected(client):
    sc = scene(BOXES[0], VIEWS[0])
    r = client.post("/solve", json=payload(sc, sc.points[:5]))
    assert r.status_code == 422
