from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps

EXIF_IFD = 0x8769
TAG_FOCAL_35MM = 41989

# Photos are normalised to at most this long side (a 12 MP 4:3 phone photo is 4032 px). Larger
# inputs (50-200 MP sensor modes) are reduced on decode so time and memory stay bounded; all
# returned coordinates and imageSize then refer to the reduced image, which keeps its aspect ratio.
MAX_SIDE = 4032
# Refuse anything bigger than this outright (decompression bombs, panoramas).
MAX_PIXELS = 50_000_000

Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ImageDecodeError(ValueError):
    pass


class ImageTooLargeError(ImageDecodeError):
    pass


@dataclass
class LoadedImage:
    bgr: np.ndarray
    focal_35mm: float | None


def _to_uint8_rgb(pil: Image.Image) -> np.ndarray:
    if pil.mode in ("I;16", "I;16B", "I;16L", "I"):
        # 16-bit / 32-bit greyscale: scale to 8 bits instead of clipping everything to white.
        arr = np.asarray(pil, dtype=np.float64)
        top = float(arr.max()) or 1.0
        grey = np.clip(arr * (255.0 / (65535.0 if top > 255 else 255.0)), 0, 255).astype(np.uint8)
        return np.repeat(grey[..., None], 3, axis=2)
    return np.asarray(pil.convert("RGB"))


def _fallback_decode(data: bytes) -> LoadedImage:
    try:
        arr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR) if data else None
    except cv2.error:
        arr = None
    if arr is None:
        raise ImageDecodeError("unreadable image")
    return LoadedImage(_limit_size(arr), None)


def _limit_size(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    if max(h, w) <= MAX_SIDE:
        return bgr
    s = MAX_SIDE / max(h, w)
    return cv2.resize(bgr, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)


def load_image(data: bytes) -> LoadedImage:
    """Decode bytes into an upright BGR image (long side <= MAX_SIDE) and read the 35 mm focal length."""
    try:
        pil = Image.open(io.BytesIO(data))
    except Image.DecompressionBombError as e:
        raise ImageTooLargeError("too many pixels") from e
    except Exception:
        return _fallback_decode(data)
    if pil.width * pil.height > MAX_PIXELS:
        raise ImageTooLargeError("too many pixels")

    focal = None
    try:
        exif = pil.getexif()
        value = exif.get_ifd(EXIF_IFD).get(TAG_FOCAL_35MM) or exif.get(TAG_FOCAL_35MM)
        if value:
            focal = float(value)
            if not (8.0 <= focal <= 400.0):
                focal = None
    except Exception:
        focal = None

    try:
        if pil.format == "JPEG" and max(pil.size) > MAX_SIDE:
            # Let the JPEG decoder skip detail (1/2, 1/4, 1/8 scale) down to no less than half of
            # MAX_SIDE - still above the marker detector's working size - which is much faster and
            # lighter than decoding 50+ MP and resizing.
            s = MAX_SIDE / 2 / max(pil.size)
            pil.draft("RGB", (int(pil.width * s) + 1, int(pil.height * s) + 1))
        pil.load()
        pil = ImageOps.exif_transpose(pil)
        rgb = _to_uint8_rgb(pil)
    except Image.DecompressionBombError as e:
        raise ImageTooLargeError("too many pixels") from e
    except Exception:
        return _fallback_decode(data)
    # 35 mm-equivalent focal length is independent of the pixel count, so resizing keeps it valid.
    return LoadedImage(_limit_size(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)), focal)
