"""Hard real-world photo conditions: light, shadow, blur, angle, resolution, orientation, formats, odd scenes."""

import io
import struct
import time
import zlib

import cv2
import numpy as np
import pytest
from PIL import Image

from app.imageio import MAX_SIDE
from app.main import MSG_BAD_IMAGE, MSG_BLURRY, MSG_NO_MARKER, MSG_TOO_LARGE
from app.synth import cast_shadow, motion_blur, uneven_light

from .conftest import BOXES, VIEWS, detect, encode, jpeg_with_exif, scene

WHITE_BOX = ((1, (238, 240, 242)), (2, (215, 218, 220)), (3, (226, 229, 231)), (4, (215, 218, 220)), (5, (226, 229, 231)))


def jpeg(bgr: np.ndarray, q: int = 90) -> bytes:
    return cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()


def solve(client, det: dict, points) -> dict:
    body = {"imageSize": det["imageSize"], "marker": det["marker"], "intrinsics": det["intrinsics"], "points": np.asarray(points).tolist()}
    r = client.post("/solve", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def dims_error(res: dict, truth) -> float:
    got = np.array([res["lengthCm"], res["widthCm"], res["heightCm"]])
    return float(np.max(np.abs(got - np.array(truth) / 10.0)))


def corner_error(det: dict, sc, scale: float = 1.0) -> float:
    expected = (sc.marker_corners + 0.5) * scale - 0.5
    return float(np.abs(np.array(det["marker"]["corners"]) - expected).max())


def check_full_pipeline(client, sc, data: bytes, corner_tol=0.5, user_tol=0.5, auto_tol: float | None = 1.0):
    """Detect, then solve with the true corners (careful user) and, if given, the auto suggestion."""
    det = detect(client, data, "photo.jpg").json()
    assert det["ok"], det
    assert corner_error(det, sc) < corner_tol
    assert dims_error(solve(client, det, sc.points), sc.box_mm) <= user_tol
    if auto_tol is not None:
        assert "otomatik bulundu" in det["message"], det["message"]
        assert dims_error(solve(client, det, det["suggestedBox"]["points"]), sc.box_mm) <= auto_tol
    return det


# --- Light and shadow -------------------------------------------------------------------------


@pytest.mark.parametrize("strength,seed", [(0.6, 1), (0.8, 2)])
def test_uneven_light(client, strength, seed):
    sc = scene(BOXES[0], VIEWS[0])
    check_full_pipeline(client, sc, jpeg(uneven_light(sc.image, strength, seed)))


def test_shadow_across_card(client):
    sc = scene(BOXES[0], VIEWS[0])
    m = sc.marker_corners
    poly = np.array([m[0] - [60, 60], m[1] - [0, 60], (m[1] + m[2]) / 2 + [30, 0], (m[0] + m[3]) / 2 - [60, 0]])
    check_full_pipeline(client, sc, jpeg(cast_shadow(sc.image, poly, 0.5, 8)))


def test_box_shadow_on_table(client):
    sc = scene(BOXES[0], VIEWS[0])
    p = sc.points
    poly = np.array([p[2], p[2] + [300, 100], p[1] + [200, 250], p[1]])
    check_full_pipeline(client, sc, jpeg(cast_shadow(sc.image, poly, 0.5, 20)))


# --- Blur ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("make", [lambda i: cv2.GaussianBlur(i, (0, 0), 2.0), lambda i: motion_blur(i, 9, 20)], ids=["focus", "shake"])
def test_moderate_blur_still_accurate(client, make):
    """Corners come from fitted edge lines, which symmetric blur does not move (was 0.6-1 px off)."""
    sc = scene(BOXES[0], VIEWS[0])
    check_full_pipeline(client, sc, jpeg(make(sc.image)), corner_tol=0.3, user_tol=0.3, auto_tol=1.0)


@pytest.mark.parametrize(
    "make", [lambda i: cv2.GaussianBlur(i, (0, 0), 6.0), lambda i: motion_blur(i, 25, 70)], ids=["focus", "shake"]
)
def test_heavy_blur_asks_for_retake(client, make):
    sc = scene(BOXES[0], VIEWS[0])
    res = detect(client, jpeg(make(sc.image)), "photo.jpg").json()
    assert res == {"ok": False, "imageSize": {"w": 1600, "h": 1200}, "message": MSG_BLURRY}


# --- Camera angle -------------------------------------------------------------------------------


@pytest.mark.parametrize("elevation", [15, 20, 25])
def test_steep_oblique_view(client, elevation):
    sc = scene(BOXES[0], (elevation, -35, 1300, 10))
    check_full_pipeline(client, sc, jpeg(sc.image), corner_tol=0.3)


def test_near_top_down_view_falls_back_to_manual_points(client):
    """Only the lid is visible: no automatic box, but the user's points still measure correctly."""
    sc = scene(BOXES[0], (80, -35, 1100, 10))
    det = check_full_pipeline(client, sc, jpeg(sc.image), auto_tol=None)
    assert "bulunamadı" in det["message"]


# --- Resolution ---------------------------------------------------------------------------------


def test_low_resolution_640(client):
    sc = scene(BOXES[0], VIEWS[0], image_size=(640, 480), focal=520.0)
    det = check_full_pipeline(client, sc, jpeg(sc.image))
    assert det["imageSize"] == {"w": 640, "h": 480}


def test_very_low_resolution_480_manual_points(client):
    sc = scene(BOXES[0], VIEWS[0], image_size=(480, 360), focal=390.0)
    check_full_pipeline(client, sc, jpeg(sc.image), auto_tol=None)


@pytest.fixture(scope="module")
def scene_12mp():
    return scene(BOXES[0], VIEWS[0], image_size=(4000, 3000), focal=3250.0, supersample=1)


def test_12mp_photo_accuracy_and_time(client, scene_12mp):
    sc = scene_12mp
    data = jpeg(sc.image, 92)
    detect(client, data, "photo.jpg")  # first call in the process pays one-off initialisation
    t0 = time.perf_counter()
    det = detect(client, data, "photo.jpg").json()
    elapsed = time.perf_counter() - t0
    assert det["ok"] and det["imageSize"] == {"w": 4000, "h": 3000}
    assert corner_error(det, sc) < 0.5
    assert dims_error(solve(client, det, sc.points), sc.box_mm) <= 0.5
    assert "otomatik bulundu" in det["message"]
    assert elapsed < 2.0, f"12 MP detect took {elapsed:.2f} s"


@pytest.mark.parametrize("fmt,expected_w", [(".jpg", 4000), (".png", MAX_SIDE)])
def test_huge_photo_is_reduced_and_coordinates_follow(client, fmt, expected_w):
    """48 MP sensor-mode photo: decoded at <= 4032 px (JPEG straight from the decoder at 1/2 scale);
    corners and imageSize refer to the reduced image."""
    sc = scene(BOXES[0], VIEWS[0])
    big = cv2.resize(sc.image, (8000, 6000), interpolation=cv2.INTER_CUBIC)
    data = jpeg(big, 85) if fmt == ".jpg" else encode(big, ".png")
    det = detect(client, data, "photo" + fmt).json()
    assert det["ok"]
    s = expected_w / 1600
    assert det["imageSize"] == {"w": expected_w, "h": expected_w * 3 // 4}
    assert corner_error(det, sc, scale=s) < 0.5 * s
    assert dims_error(solve(client, det, (sc.points + 0.5) * s - 0.5), sc.box_mm) <= 0.5


def _png_header_only(w: int, h: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00" * 64)) + chunk(b"IEND", b"")


def test_absurd_pixel_count_rejected_before_decoding(client):
    r = detect(client, _png_header_only(20000, 15000), "huge.png")
    assert r.status_code == 400
    assert r.json() == {"ok": False, "imageSize": {"w": 0, "h": 0}, "message": MSG_TOO_LARGE}


def test_pixel_limit_is_50_mp(client):
    # 8000 x 7000 = 56 MP: sınırın (50 MP) üstünde, kod çözülmeden reddedilir.
    r = detect(client, _png_header_only(8000, 7000), "big.png")
    assert r.status_code == 400
    assert r.json()["message"] == MSG_TOO_LARGE


# --- Orientation --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "orientation,stored_rotation",
    [(3, cv2.ROTATE_180), (6, cv2.ROTATE_90_COUNTERCLOCKWISE), (8, cv2.ROTATE_90_CLOCKWISE)],
)
def test_exif_orientations(client, orientation, stored_rotation):
    sc = scene(BOXES[0], VIEWS[0])
    data = jpeg_with_exif(cv2.rotate(sc.image, stored_rotation), orientation=orientation)
    det = check_full_pipeline(client, sc, data)
    assert det["imageSize"] == {"w": 1600, "h": 1200}


def test_portrait_photo(client):
    """Phone held upright: 1200x1600 image (already upright pixels)."""
    sc = scene(BOXES[0], (50, -35, 1500, 10), image_size=(1200, 1600))
    det = check_full_pipeline(client, sc, jpeg(sc.image))
    assert det["imageSize"] == {"w": 1200, "h": 1600}


# --- File formats -------------------------------------------------------------------------------


def _pil_bytes(img: Image.Image, fmt: str, **kw) -> bytes:
    out = io.BytesIO()
    img.save(out, fmt, **kw)
    return out.getvalue()


def _formats(bgr: np.ndarray) -> dict[str, bytes]:
    rgb = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return {
        "png": encode(bgr, ".png"),
        "png-rgba": _pil_bytes(rgb.convert("RGBA"), "PNG"),
        "png-grey": encode(grey, ".png"),
        "png-grey-16bit": encode(grey.astype(np.uint16) * 257, ".png"),
        "webp": _pil_bytes(rgb, "WEBP", quality=90),
        "jpeg-q60": jpeg(bgr, 60),
    }


@pytest.mark.parametrize("fmt", ["png", "png-rgba", "png-grey", "png-grey-16bit", "webp", "jpeg-q60"])
def test_image_formats(client, fmt):
    sc = scene(BOXES[0], VIEWS[0])
    det = detect(client, _formats(sc.image)[fmt], "photo").json()
    assert det["ok"], det
    assert corner_error(det, sc) < 0.5
    assert dims_error(solve(client, det, sc.points), sc.box_mm) <= 0.5


@pytest.mark.parametrize(
    "data",
    [
        b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 256,  # HEIC (iPhone) container
        b"",
        b"%PDF-1.7\n" + b"0" * 100,
    ],
    ids=["heic", "empty", "pdf"],
)
def test_unsupported_files_get_readable_message(client, data):
    r = detect(client, data, "photo")
    assert r.status_code == 400
    assert r.json() == {"ok": False, "imageSize": {"w": 0, "h": 0}, "message": MSG_BAD_IMAGE}


def test_truncated_jpeg_never_crashes(client):
    sc = scene(BOXES[0], VIEWS[0])
    data = jpeg(sc.image)
    r = detect(client, data[: len(data) // 2], "photo.jpg")
    assert r.status_code in (200, 400)
    assert "message" in r.json()


# --- Odd scenes ---------------------------------------------------------------------------------


def test_card_partly_outside_frame(client):
    sc = scene(BOXES[0], VIEWS[0])
    x0 = int(sc.marker_corners[:, 0].min()) + 30  # cut through the black square
    res = detect(client, jpeg(np.ascontiguousarray(sc.image[:, x0:])), "photo.jpg").json()
    assert res["ok"] is False and res["message"] == MSG_NO_MARKER


def test_card_margin_cut_but_marker_visible(client):
    """Only the white margin is cropped: the black square is all that matters."""
    sc = scene(BOXES[0], VIEWS[0])
    x0 = int(sc.marker_corners[:, 0].min()) - 4
    res = detect(client, jpeg(np.ascontiguousarray(sc.image[:, x0:])), "photo.jpg").json()
    assert res["ok"]
    assert np.abs(np.array(res["marker"]["corners"]) - (sc.marker_corners - [x0, 0])).max() < 0.5


def test_two_cards_uses_the_larger_one_and_still_measures(client):
    sc = scene(BOXES[0], VIEWS[0], extra_cards=((-200.0, -150.0),))
    det = detect(client, jpeg(sc.image), "photo.jpg").json()
    assert det["ok"]
    corners = np.array(det["marker"]["corners"])
    # Both cards lie on the table, so either one gives the right scale; the larger is more precise.
    assert np.abs(corners - sc.marker_corners).max() > 50
    assert dims_error(solve(client, det, sc.points), sc.box_mm) <= 0.5


def test_white_box_same_colour_as_card(client):
    sc = scene(BOXES[0], VIEWS[0], box_shades=WHITE_BOX)
    check_full_pipeline(client, sc, jpeg(sc.image))


def test_no_card_with_box(client):
    sc = scene(BOXES[0], VIEWS[0])
    img = sc.image.copy()
    cv2.fillConvexPoly(img, cv2.convexHull(np.round(sc.marker_corners).astype(np.int32)), (150, 160, 170))
    res = detect(client, jpeg(img), "photo.jpg").json()
    assert res == {"ok": False, "imageSize": {"w": 1600, "h": 1200}, "message": MSG_NO_MARKER}
