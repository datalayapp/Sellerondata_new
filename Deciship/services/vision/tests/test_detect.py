import cv2
import numpy as np
import pytest

from app.geometry import FULL_FRAME_DIAGONAL_MM

from .conftest import BOXES, VIEWS, detect, encode, jpeg_with_exif, scene

NO_MARKER = "Referans kartı bulunamadı. Kartın tamamı görünecek şekilde tekrar çekin."


@pytest.mark.parametrize("view", VIEWS)
def test_marker_corners_subpixel(client, view):
    sc = scene(BOXES[0], view)
    res = detect(client, encode(sc.image)).json()
    assert res["ok"] is True
    assert res["marker"]["id"] == 7
    assert res["imageSize"] == {"w": 1600, "h": 1200}
    corners = np.array(res["marker"]["corners"])
    assert np.abs(corners - sc.marker_corners).max() < 1.0
    assert len(res["suggestedBox"]["points"]) == 6
    assert res["intrinsics"]["source"] == "estimated"


def test_detect_jpeg(client):
    sc = scene(BOXES[1], VIEWS[0])
    res = detect(client, encode(sc.image, ".jpg"), "photo.jpg").json()
    assert res["ok"]
    assert np.abs(np.array(res["marker"]["corners"]) - sc.marker_corners).max() < 1.0


@pytest.mark.parametrize("box", BOXES)
def test_suggested_box_found_automatically(client, box):
    sc = scene(box, VIEWS[0])
    res = detect(client, encode(sc.image)).json()
    pts = np.array(res["suggestedBox"]["points"])
    assert res["suggestedBox"]["auto"] is True
    assert "otomatik bulundu" in res["message"]
    assert np.abs(pts - sc.points).max() < 6.0


def test_default_layout_when_box_missing(client):
    sc = scene(BOXES[0], VIEWS[0], draw_box=False)
    res = detect(client, encode(sc.image)).json()
    assert res["ok"]
    pts = np.array(res["suggestedBox"]["points"])
    assert pts.shape == (6, 2)
    assert np.all((pts[:, 0] >= 0) & (pts[:, 0] < 1600) & (pts[:, 1] >= 0) & (pts[:, 1] < 1200))
    assert res["suggestedBox"]["auto"] is False
    assert "bulunamadı" in res["message"]


def test_exif_orientation_returns_upright_coordinates(client):
    sc = scene(BOXES[0], VIEWS[0])
    # Orientation 6: stored pixels must be rotated 90 deg clockwise for display.
    stored = cv2.rotate(sc.image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    res = detect(client, jpeg_with_exif(stored, orientation=6), "photo.jpg").json()
    assert res["ok"]
    assert res["imageSize"] == {"w": 1600, "h": 1200}
    assert np.abs(np.array(res["marker"]["corners"]) - sc.marker_corners).max() < 1.0


def test_exif_focal_length_used(client):
    sc = scene(BOXES[0], VIEWS[0])
    res = detect(client, jpeg_with_exif(sc.image, focal_35mm=26), "photo.jpg").json()
    intr = res["intrinsics"]
    assert intr["source"] == "exif"
    expected = 26 * np.hypot(1600, 1200) / FULL_FRAME_DIAGONAL_MM
    assert intr["fx"] == pytest.approx(expected, rel=1e-3)
    assert intr["cx"] == 800 and intr["cy"] == 600


def test_no_marker_message(client):
    img = np.full((900, 1200, 3), 140, np.uint8)
    cv2.rectangle(img, (400, 300), (800, 600), (60, 120, 170), -1)
    res = detect(client, encode(img)).json()
    assert res == {"ok": False, "imageSize": {"w": 1200, "h": 900}, "message": NO_MARKER}


def test_unreadable_image(client):
    r = detect(client, b"not an image", "x.jpg")
    assert r.status_code == 400
    assert r.json()["ok"] is False


def test_health(client):
    assert client.get("/health").json()["ok"] is True
