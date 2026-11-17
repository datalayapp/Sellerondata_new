from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import numpy as np
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .detect import MARKER_ID, MAX_MARKER_BLUR, find_marker, suggest_box, warm_up
from .geometry import (
    GeometryError,
    Intrinsics,
    confidence,
    default_intrinsics,
    estimate_intrinsics,
    fit_cuboid,
    refine_focal,
    solve_box,
)
from .imageio import ImageDecodeError, ImageTooLargeError, load_image
from .scale import read_scale

MSG_NO_MARKER = "Referans kartı bulunamadı. Kartın tamamı görünecek şekilde tekrar çekin."
MSG_BAD_IMAGE = "Fotoğraf okunamadı. Lütfen JPEG veya PNG bir fotoğraf gönderin."
MSG_TOO_LARGE = "Fotoğraf çok büyük. Telefon kamerasının normal çözünürlüğüyle tekrar çekin."
MSG_BLURRY = "Fotoğraf bulanık, ölçü hatalı çıkar. Telefonu sabit tutup tekrar çekin."
MSG_BOX_FOUND = "Kutu köşeleri otomatik bulundu; gerekirse noktaları köşelere sürükleyin."
MSG_BOX_DEFAULT = "Kutu köşeleri otomatik bulunamadı; noktaları kutunun köşelerine sürükleyin."
MSG_BAD_POINTS = "Noktalar geçerli bir kutu oluşturmuyor. Alt köşeleri masaya değen köşelere, üst köşeleri hemen üstlerine yerleştirin."
MSG_SCALE_OFF = "Ücretsiz tartı okuma kapalı."
MSG_SCALE_READ = "Tartı ekranı okundu; değeri kontrol edin."
MSG_SCALE_UNREADABLE = "Tartı ekranı okunamadı; ağırlığı elle girin."


@asynccontextmanager
async def lifespan(_: FastAPI):
    warm_up()
    yield


app = FastAPI(title="DeciShip Vision", version="1.0.0", lifespan=lifespan)

Point = Annotated[list[float], Field(min_length=2, max_length=2)]


class ImageSize(BaseModel):
    w: int = Field(gt=0)
    h: int = Field(gt=0)


class MarkerIn(BaseModel):
    corners: Annotated[list[Point], Field(min_length=4, max_length=4)]
    id: int | None = None


class IntrinsicsIn(BaseModel):
    fx: float = Field(gt=0)
    fy: float = Field(gt=0)
    cx: float
    cy: float
    source: Literal["exif", "estimated", "default"] = "estimated"


class SolveIn(BaseModel):
    imageSize: ImageSize
    marker: MarkerIn
    intrinsics: IntrinsicsIn | None = None
    points: Annotated[list[Point], Field(min_length=6, max_length=6)]


def _pts(points: np.ndarray) -> list[list[float]]:
    return [[round(float(x), 2), round(float(y), 2)] for x, y in points]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "vision"}


@app.post("/detect")
def detect(image: UploadFile = File(...)):
    data = image.file.read()
    try:
        loaded = load_image(data)
    except ImageTooLargeError:
        return JSONResponse(status_code=400, content={"ok": False, "imageSize": {"w": 0, "h": 0}, "message": MSG_TOO_LARGE})
    except ImageDecodeError:
        return JSONResponse(status_code=400, content={"ok": False, "imageSize": {"w": 0, "h": 0}, "message": MSG_BAD_IMAGE})
    bgr = loaded.bgr
    h, w = bgr.shape[:2]
    marker = find_marker(bgr)
    if marker is None:
        return {"ok": False, "imageSize": {"w": w, "h": h}, "message": MSG_NO_MARKER}
    if marker.blur > MAX_MARKER_BLUR:
        return {"ok": False, "imageSize": {"w": w, "h": h}, "message": MSG_BLURRY}
    intr = estimate_intrinsics(marker.corners, w, h, loaded.focal_35mm)
    points, found = suggest_box(bgr, marker.corners, intr)
    return {
        "ok": True,
        "marker": {"corners": _pts(marker.corners), "id": MARKER_ID},
        "imageSize": {"w": w, "h": h},
        "intrinsics": intr.to_json(),
        "suggestedBox": {"points": _pts(points), "auto": bool(found)},
        "message": MSG_BOX_FOUND if found else MSG_BOX_DEFAULT,
    }


@app.post("/solve")
def solve(body: SolveIn):
    w, h = body.imageSize.w, body.imageSize.h
    corners = np.array(body.marker.corners, dtype=np.float64)
    points = np.array(body.points, dtype=np.float64)
    if body.intrinsics is not None:
        i = body.intrinsics
        intr = Intrinsics(i.fx, i.fy, i.cx, i.cy, i.source)
    else:
        intr = estimate_intrinsics(corners, w, h, None)

    refined = False
    try:
        if intr.source == "exif":
            sol = solve_box(points, corners, intr)
        else:
            try:
                sol = refine_focal(points, corners, intr, w, h)
                refined = True
            except GeometryError:
                sol = solve_box(points, corners, intr if intr.source != "default" else default_intrinsics(w, h))
    except GeometryError:
        return JSONResponse(status_code=422, content={"message": MSG_BAD_POINTS})

    if not (30.0 <= sol.angle_b2_deg <= 150.0) or sol.height_mm <= 0:
        return JSONResponse(status_code=422, content={"message": MSG_BAD_POINTS})

    fit = None
    try:
        fit = fit_cuboid(points, corners, sol, fix_focal=intr.source == "exif")
    except (np.linalg.LinAlgError, ValueError):
        fit = None
    init_dims = np.array([sol.length_mm, sol.width_mm, sol.height_mm])
    if fit is not None and fit.point_rms_px > 40.0:
        fit = None
    if fit is not None:
        fit_dims = np.array([fit.length_mm, fit.width_mm, fit.height_mm])
        if np.all(np.abs(fit_dims - init_dims) <= np.maximum(0.15 * init_dims, 15.0)):
            dims = fit_dims
        else:
            fit = None
            dims = init_dims
    else:
        dims = init_dims

    if not np.all(np.isfinite(dims)) or dims.min() <= 5 or dims.max() > 5000:
        return JSONResponse(status_code=422, content={"message": MSG_BAD_POINTS})

    return {
        "lengthCm": round(float(dims[0]) / 10.0, 1),
        "widthCm": round(float(dims[1]) / 10.0, 1),
        "heightCm": round(float(dims[2]) / 10.0, 1),
        "confidence": confidence(sol, fit.point_rms_px if fit else None),
        "debug": {
            "method": "cuboid-fit" if fit else "ray-plane",
            "focalPx": round(fit.focal_px if fit else sol.intrinsics.fx, 1),
            "intrinsicsSource": intr.source,
            "focalRefined": refined,
            "markerReprojErrorPx": round(sol.marker_reproj_px, 3),
            "angleB2Deg": round(sol.angle_b2_deg, 2),
            "heightsCm": [round(x / 10.0, 2) for x in sol.heights_mm],
            "heightsUsed": sol.kept,
            "topResidualPx": [round(x, 2) for x in sol.top_residual_px],
            "cameraHeightCm": round(sol.pose.camera_height_mm / 10.0, 1),
            "rayPlaneCm": [round(float(x) / 10.0, 2) for x in init_dims],
            "fitPointRmsPx": round(fit.point_rms_px, 2) if fit else None,
        },
    }


def scale_free_read_enabled() -> bool:
    """SCALE_FREE_READ=1 turns the free (no-AI) scale reader on; off by default until it has been
    measured on real photos (tools/scale_eval.py)."""
    return os.environ.get("SCALE_FREE_READ", "0").strip().lower() in ("1", "true", "yes", "on")


def _plain(v):
    """JSON-safe copy of the debug data (numpy numbers, tuples)."""
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    return v


@app.post("/scale/read-free")
def scale_read_free(image: UploadFile = File(...)):
    """Seven-segment scale display -> weight, without AI. Not called by the API yet."""
    if not scale_free_read_enabled():
        return JSONResponse(status_code=404, content={"ok": False, "message": MSG_SCALE_OFF})
    data = image.file.read()
    try:
        loaded = load_image(data)
    except ImageTooLargeError:
        return JSONResponse(status_code=400, content={"ok": False, "message": MSG_TOO_LARGE})
    except ImageDecodeError:
        return JSONResponse(status_code=400, content={"ok": False, "message": MSG_BAD_IMAGE})
    r = read_scale(loaded.bgr)
    h, w = loaded.bgr.shape[:2]
    return {
        "ok": r.ok,
        # Only a reading that passed every check is returned; otherwise the weight is entered by hand.
        "weightKg": r.weight_kg if r.ok else None,
        "unit": r.unit if r.ok else None,
        "unitAssumed": bool(r.unit_assumed) if r.ok else False,
        "rawText": r.text if r.ok else "",
        "confidence": round(float(r.confidence), 3) if r.ok else 0.0,
        "reason": r.reason,
        "message": MSG_SCALE_READ if r.ok else MSG_SCALE_UNREADABLE,
        "imageSize": {"w": w, "h": h},
        "debug": {"elapsedMs": round(r.elapsed_ms), "rows": _plain(r.rows)},
    }
