import io
from functools import lru_cache

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.synth import render_scene

BOXES = [(400.0, 300.0, 250.0), (300.0, 200.0, 150.0), (500.0, 400.0, 300.0)]
# (elevation_deg, azimuth_deg, distance_mm, box_yaw_deg): oblique views showing three faces.
VIEWS = [(50, -35, 1100, 10), (40, -25, 1300, 20), (60, -50, 1000, -5), (35, -60, 1400, -30), (65, -20, 1100, 10)]


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def scene(box, view, **kw):
    """Rendered once per parameter set and shared; tests must not modify the returned scene."""
    return _scene(tuple(box), tuple(view), tuple(sorted(kw.items())))


@lru_cache(maxsize=None)
def _scene(box, view, kw):
    el, az, dist, yaw = view
    sc = render_scene(box=box, elevation_deg=el, azimuth_deg=az, distance=dist, yaw_deg=yaw, **dict(kw))
    for arr in (sc.image, sc.points, sc.marker_corners):
        arr.flags.writeable = False
    return sc


def encode(bgr: np.ndarray, fmt: str = ".png") -> bytes:
    params = [cv2.IMWRITE_JPEG_QUALITY, 92] if fmt == ".jpg" else []
    ok, buf = cv2.imencode(fmt, bgr, params)
    assert ok
    return buf.tobytes()


def jpeg_with_exif(bgr: np.ndarray, orientation: int | None = None, focal_35mm: int | None = None) -> bytes:
    img = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    exif = Image.Exif()
    if orientation is not None:
        exif[0x0112] = orientation
    if focal_35mm is not None:
        exif.get_ifd(0x8769)[41989] = focal_35mm
    out = io.BytesIO()
    img.save(out, "JPEG", quality=95, exif=exif)
    return out.getvalue()


def detect(client, data: bytes, name: str = "photo.png"):
    return client.post("/detect", files={"image": (name, data, "application/octet-stream")})
