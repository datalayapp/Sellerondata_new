"""Render synthetic reference-card photos into <repo>/samples/vision/ with ground truth.

Usage: python tools/make_samples.py
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.geometry import FULL_FRAME_DIAGONAL_MM  # noqa: E402
from app.synth import render_scene  # noqa: E402

OUT = Path(__file__).resolve().parents[3] / "samples" / "vision"

SAMPLES = [
    ("box-40x30x25.jpg", dict(box=(400.0, 300.0, 250.0), elevation_deg=50, azimuth_deg=-35, distance=1100, yaw_deg=10)),
    ("box-30x20x15.jpg", dict(box=(300.0, 200.0, 150.0), elevation_deg=40, azimuth_deg=-25, distance=1300, yaw_deg=20)),
    ("box-50x40x30.jpg", dict(box=(500.0, 400.0, 300.0), elevation_deg=60, azimuth_deg=-50, distance=1000, yaw_deg=-5)),
]


def pts(a: np.ndarray) -> list[list[float]]:
    return [[round(float(x), 2), round(float(y), 2)] for x, y in a]


def jpeg(bgr: np.ndarray, exif: Image.Exif | None = None) -> bytes:
    img = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90, exif=exif if exif is not None else Image.Exif())
    return buf.getvalue()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    truth = {}
    for name, params in SAMPLES:
        sc = render_scene(**params)
        (OUT / name).write_bytes(jpeg(sc.image))
        truth[name] = {
            "expectedCm": {"lengthCm": round(sc.box_mm[0] / 10, 1), "widthCm": round(sc.box_mm[1] / 10, 1), "heightCm": round(sc.box_mm[2] / 10, 1)},
            "imageSize": {"w": sc.image.shape[1], "h": sc.image.shape[0]},
            "markerCorners": pts(sc.marker_corners),
            "points": pts(sc.points),
            "trueFocalPx": float(sc.K[0, 0]),
        }

    # Phone-style file: pixels stored sideways with EXIF Orientation=6 and a 35 mm focal length.
    params = dict(box=(400.0, 300.0, 250.0), elevation_deg=45, azimuth_deg=-40, distance=1150, yaw_deg=5)
    sc = render_scene(**params)
    f35 = int(round(sc.K[0, 0] * FULL_FRAME_DIAGONAL_MM / np.hypot(*sc.image.shape[:2])))
    exif = Image.Exif()
    exif[0x0112] = 6
    exif.get_ifd(0x8769)[41989] = f35
    name = "box-40x30x25-exif-rotated.jpg"
    (OUT / name).write_bytes(jpeg(cv2.rotate(sc.image, cv2.ROTATE_90_COUNTERCLOCKWISE), exif))
    truth[name] = {
        "expectedCm": {"lengthCm": round(sc.box_mm[0] / 10, 1), "widthCm": round(sc.box_mm[1] / 10, 1), "heightCm": round(sc.box_mm[2] / 10, 1)},
        "imageSize": {"w": sc.image.shape[1], "h": sc.image.shape[0]},
        "markerCorners": pts(sc.marker_corners),
        "points": pts(sc.points),
        "trueFocalPx": float(sc.K[0, 0]),
        "note": f"EXIF Orientation=6, FocalLengthIn35mmFilm={f35}; coordinates are in the upright image",
    }

    sc = render_scene(box=(400.0, 300.0, 250.0), elevation_deg=50, azimuth_deg=-35, distance=1100, yaw_deg=10)
    img = sc.image.copy()
    corners = np.round(sc.marker_corners).astype(np.int32)
    cv2.fillConvexPoly(img, cv2.convexHull(corners), (150, 160, 170))
    (OUT / "no-marker.jpg").write_bytes(jpeg(img))
    truth["no-marker.jpg"] = {"expected": "ok:false, Referans kartı bulunamadı"}

    (OUT / "ground-truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(truth)} samples to {OUT}")


if __name__ == "__main__":
    main()
