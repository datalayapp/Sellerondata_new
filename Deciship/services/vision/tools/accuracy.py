"""Synthetic accuracy report for the reference-card service: edge (L/W/H) error, mean and 95th percentile.

Renders known boxes beside the card under several photo conditions, runs /detect then /solve
in-process and compares with the ground truth.

  user   : the 6 true corners with +-2 px uniform noise (what a careful user drags to)
  auto   : the corners /detect suggests, untouched (only when it reports them as found)

Usage: python tools/accuracy.py [--quick]
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.synth import cast_shadow, motion_blur, render_scene, uneven_light  # noqa: E402

BOXES = [(400.0, 300.0, 250.0), (300.0, 200.0, 150.0), (500.0, 400.0, 300.0), (250.0, 250.0, 120.0), (600.0, 400.0, 350.0)]
# (elevation_deg, azimuth_deg, distance_mm, box_yaw_deg)
VIEWS = [(50, -35, 1100, 10), (40, -25, 1300, 20), (60, -50, 1000, -5), (35, -60, 1400, -30), (65, -20, 1100, 10), (25, -40, 1500, 15)]


def _shadow(sc):
    m = sc.marker_corners
    poly = np.array([m[0] - [80, 80], m[1] - [0, 80], (m[1] + m[2]) / 2 + [40, 0], (m[0] + m[3]) / 2 - [80, 0]])
    return cast_shadow(sc.image, poly, 0.5, 10)


CONDITIONS = {
    "temiz": lambda sc: sc.image,
    "düzensiz ışık": lambda sc: uneven_light(sc.image, 0.7, 3),
    "karta gölge": _shadow,
    "bulanık (σ=2 px)": lambda sc: cv2.GaussianBlur(sc.image, (0, 0), 2.0),
    "titreme (9 px)": lambda sc: motion_blur(sc.image, 9, 30),
}


def jpeg(img: np.ndarray, q: int = 85) -> bytes:
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()


def solve(client, det, pts) -> np.ndarray | None:
    body = {"imageSize": det["imageSize"], "marker": det["marker"], "intrinsics": det["intrinsics"], "points": np.asarray(pts).tolist()}
    r = client.post("/solve", json=body)
    if r.status_code != 200:
        return None
    j = r.json()
    return np.array([j["lengthCm"], j["widthCm"], j["heightCm"]])


def stats(errs: list[float]) -> str:
    if not errs:
        return "—"
    a = np.array(errs)
    return f"{a.mean():.2f} / {np.percentile(a, 95):.2f} / {a.max():.2f}"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    quick = "--quick" in sys.argv
    boxes, views = (BOXES[:2], VIEWS[:3]) if quick else (BOXES, VIEWS)
    client = TestClient(app)
    rng = np.random.default_rng(42)
    scenes = [(b, v, render_scene(box=b, elevation_deg=v[0], azimuth_deg=v[1], distance=v[2], yaw_deg=v[3])) for b in boxes for v in views]
    print(f"{len(scenes)} sahne x {len(CONDITIONS)} koşul\n")
    print("| Koşul | Kart bulundu | Kutu otomatik | Kullanıcı noktaları: ort / p95 / en kötü (cm) | Otomatik noktalar: ort / p95 / en kötü (cm) | detect ort. ms |")
    print("|---|---|---|---|---|---|")
    all_user, all_auto = [], []
    for name, fn in CONDITIONS.items():
        found = auto_found = 0
        user_err, auto_err, ms = [], [], []
        for _, _, sc in scenes:
            truth = np.array(sc.box_mm) / 10.0
            t0 = time.perf_counter()
            det = client.post("/detect", files={"image": ("p.jpg", jpeg(fn(sc)), "image/jpeg")}).json()
            ms.append((time.perf_counter() - t0) * 1000)
            if not det.get("ok"):
                continue
            found += 1
            got = solve(client, det, sc.points + rng.uniform(-2, 2, sc.points.shape))
            if got is not None:
                user_err += list(np.abs(got - truth))
            if "otomatik bulundu" in det["message"]:
                auto_found += 1
                got = solve(client, det, det["suggestedBox"]["points"])
                if got is not None:
                    auto_err += list(np.abs(got - truth))
        all_user += user_err
        all_auto += auto_err
        n = len(scenes)
        print(f"| {name} | {found}/{n} | {auto_found}/{n} | {stats(user_err)} | {stats(auto_err)} | {np.mean(ms):.0f} |")
    print(f"| **toplam** |  |  | {stats(all_user)} | {stats(all_auto)} |  |")


if __name__ == "__main__":
    main()
