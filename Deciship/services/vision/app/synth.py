"""Synthetic scenes (box + reference card on a table) for tests and sample photos."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import MARKER_OBJECT_POINTS, MARKER_SIZE_MM

MARKER_ID = 7
CARD_SIZE_MM = 130.0


@dataclass
class Scene:
    image: np.ndarray  # BGR
    K: np.ndarray
    R: np.ndarray
    t: np.ndarray
    marker_corners: np.ndarray  # 4x2, ArUco order
    points: np.ndarray  # 6x2, [B1,B2,B3,T1,T2,T3]
    box_mm: tuple[float, float, float]  # (|B1B2|, |B2B3|, height)


def look_at(camera: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    f = target - camera
    f = f / np.linalg.norm(f)
    x = np.cross(f, np.array([0.0, 0.0, 1.0]))
    x = x / np.linalg.norm(x)
    y = np.cross(f, x)
    R = np.stack([x, y, f])
    return R, -R @ camera


def project_world(pts: np.ndarray, K: np.ndarray, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    pc = (R @ np.asarray(pts, dtype=np.float64).T).T + t
    p = (K @ pc.T).T
    return p[:, :2] / p[:, 2:3]


def card_texture(px_per_mm: float = 8.0) -> np.ndarray:
    size = int(round(CARD_SIZE_MM * px_per_mm))
    card = np.full((size, size), 255, np.uint8)
    marker_px = int(round(MARKER_SIZE_MM * px_per_mm))
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    marker = cv2.aruco.generateImageMarker(dictionary, MARKER_ID, 6)
    marker = cv2.resize(marker, (marker_px, marker_px), interpolation=cv2.INTER_NEAREST)
    off = (size - marker_px) // 2
    card[off : off + marker_px, off : off + marker_px] = marker
    return card


def box_corners_world(center_xy, length, width, height, yaw_deg) -> np.ndarray:
    """8 corners: 0..3 bottom (counter-clockwise), 4..7 top above them."""
    c, s = np.cos(np.radians(yaw_deg)), np.sin(np.radians(yaw_deg))
    ax, ay = np.array([c, s]) * length / 2, np.array([-s, c]) * width / 2
    cxy = np.asarray(center_xy, dtype=np.float64)
    base = [cxy - ax - ay, cxy + ax - ay, cxy + ax + ay, cxy - ax + ay]
    bottom = [np.array([p[0], p[1], 0.0]) for p in base]
    top = [np.array([p[0], p[1], height]) for p in base]
    return np.array(bottom + top)


def render_scene(
    box=(400.0, 300.0, 250.0),
    image_size=(1600, 1200),
    focal=1300.0,
    elevation_deg=50.0,
    azimuth_deg=-35.0,
    distance=1100.0,
    yaw_deg=10.0,
    box_offset=(0.0, 0.0),
    seed=0,
    supersample=3,
    draw_box=True,
    box_shades: dict | None = None,
    extra_cards: tuple = (),
) -> Scene:
    """Render a box and the reference card on a table.

    box_shades: optional {face_index: BGR} override (e.g. a white box like the card).
    extra_cards: world (x, y) centres of further identical cards (e.g. two cards in view).
    """
    w, h = image_size
    L, W, H = box
    rng = np.random.default_rng(seed)
    K = np.array([[focal, 0, w / 2.0], [0, focal, h / 2.0], [0, 0, 1]])

    gap = 60.0
    box_center = np.array([CARD_SIZE_MM / 2 + gap + max(L, W) / 2 + box_offset[0], box_offset[1]])
    corners = box_corners_world(box_center, L, W, H, yaw_deg)
    target = np.array([box_center[0] * 0.55, 0.0, H * 0.3])
    az, el = np.radians(azimuth_deg), np.radians(elevation_deg)
    camera = target + distance * np.array([np.cos(el) * np.sin(az), -np.cos(el) * np.cos(az), np.sin(el)])
    R, t = look_at(camera, target)

    s = supersample
    Ks = K.copy()
    Ks[:2] *= s
    Ks[0, 2] += (s - 1) / 2.0
    Ks[1, 2] += (s - 1) / 2.0
    W2, H2 = w * s, h * s

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = 150 + 25 * (xx / w) - 15 * (yy / h)
    table = np.stack([base * 0.75, base * 0.88, base], axis=-1)
    table += rng.normal(0, 4, (h, w, 1))
    img = cv2.resize(table.astype(np.float32), (W2, H2), interpolation=cv2.INTER_LINEAR)

    tex = card_texture(px_per_mm=4.0)
    n_px = tex.shape[0]
    half = CARD_SIZE_MM / 2
    src = np.array([[0, 0], [n_px, 0], [n_px, n_px], [0, n_px]], np.float32) - 0.5
    for cx, cy in ((0.0, 0.0), *extra_cards):
        card_world = np.array([[cx - half, cy + half, 0], [cx + half, cy + half, 0], [cx + half, cy - half, 0], [cx - half, cy - half, 0]])
        dst = project_world(card_world, Ks, R, t).astype(np.float32)
        Hm = cv2.getPerspectiveTransform(src, dst)
        warped = cv2.warpPerspective(tex.astype(np.float32), Hm, (W2, H2), flags=cv2.INTER_LINEAR)
        mask = cv2.warpPerspective(np.ones(tex.shape, np.float32), Hm, (W2, H2), flags=cv2.INTER_LINEAR)
        paper = np.stack([warped * 0.92, warped * 0.94, warped * 0.95], axis=-1)
        img = img * (1 - mask[..., None]) + paper * mask[..., None]

    # Box: draw visible faces, back to front.
    cam_w = -R.T @ t
    faces = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    center3 = corners.mean(axis=0)
    shades = {1: (95, 160, 205), 2: (55, 115, 160), 3: (70, 130, 180), 4: (55, 115, 160), 5: (70, 130, 180)}
    if box_shades:
        shades.update(box_shades)
    proj_s = project_world(corners, Ks, R, t)
    visible = []
    for fi, face in enumerate(faces):
        pts3 = corners[list(face)]
        normal = np.cross(pts3[1] - pts3[0], pts3[2] - pts3[0])
        if normal @ (pts3.mean(axis=0) - center3) < 0:
            normal = -normal
        if normal @ (cam_w - pts3.mean(axis=0)) > 0 and fi != 0:
            visible.append((np.linalg.norm(cam_w - pts3.mean(axis=0)), fi, face))
    for _, fi, face in sorted(visible, reverse=True) if draw_box else []:
        poly = np.round(proj_s[list(face)] * 16).astype(np.int32)
        cv2.fillConvexPoly(img, poly, shades[fi], lineType=cv2.LINE_AA, shift=4)

    img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
    img = cv2.GaussianBlur(img, (0, 0), 0.6)
    img += rng.normal(0, 2.0, img.shape)
    img = np.clip(img, 0, 255).astype(np.uint8)

    marker_corners = project_world(MARKER_OBJECT_POINTS, K, R, t)

    bottom_proj = project_world(corners[:4], K, R, t)
    dists = [np.linalg.norm(cam_w - corners[i]) for i in range(4)]
    b2 = int(np.argmin(dists))
    na, nb = (b2 - 1) % 4, (b2 + 1) % 4
    b1, b3 = (na, nb) if bottom_proj[na][0] < bottom_proj[nb][0] else (nb, na)
    order = [b1, b2, b3, b1 + 4, b2 + 4, b3 + 4]
    points = project_world(corners[order], K, R, t)
    l12 = float(np.linalg.norm(corners[b1] - corners[b2]))
    l23 = float(np.linalg.norm(corners[b3] - corners[b2]))
    return Scene(img, K, R, t, marker_corners, points, (l12, l23, H))


# --- Photo degradations for robustness tests -------------------------------------------------


def uneven_light(img: np.ndarray, strength: float = 0.55, seed: int = 0) -> np.ndarray:
    """Multiply by a smooth vignette + side-light field (brightness from 1-strength to ~1.1)."""
    h, w = img.shape[:2]
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    lx, ly = rng.uniform(0.0, 1.0, 2)
    d = np.hypot(xx / w - lx, yy / h - ly) / np.sqrt(2)
    field = 1.1 - strength * d / max(float(d.max()), 1e-6)
    return np.clip(img.astype(np.float32) * field[..., None], 0, 255).astype(np.uint8)


def cast_shadow(img: np.ndarray, polygon: np.ndarray, darkness: float = 0.45, softness_px: float = 25.0) -> np.ndarray:
    """Darken a (soft-edged) polygon, e.g. the shadow a box or a hand casts over the card."""
    h, w = img.shape[:2]
    mask = np.zeros((h, w), np.float32)
    cv2.fillPoly(mask, [np.round(polygon).astype(np.int32)], 1.0)
    if softness_px > 0:
        mask = cv2.GaussianBlur(mask, (0, 0), softness_px)
    field = 1.0 - darkness * mask
    return np.clip(img.astype(np.float32) * field[..., None], 0, 255).astype(np.uint8)


def motion_blur(img: np.ndarray, length_px: int = 9, angle_deg: float = 20.0) -> np.ndarray:
    k = np.zeros((length_px, length_px), np.float32)
    k[length_px // 2, :] = 1.0
    rot = cv2.getRotationMatrix2D(((length_px - 1) / 2, (length_px - 1) / 2), angle_deg, 1.0)
    k = cv2.warpAffine(k, rot, (length_px, length_px))
    k /= k.sum()
    return cv2.filter2D(img, -1, k)
