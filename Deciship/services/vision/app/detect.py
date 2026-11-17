from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import (
    GeometryError,
    Intrinsics,
    Pose,
    marker_poses,
    project,
    solve_height,
    table_point,
)

MARKER_ID = 7
DETECT_MAX_SIDE = 2400
BOX_MAX_SIDE = 1280
MAX_VERTICAL_DEVIATION_DEG = 14.0
# Automatic box outline checks (a wrong outline is worse than none: the user may not drag it).
MAX_CORNER_ANGLE_DEVIATION_DEG = 10.0  # bottom corner B2 must be 90 +- this on the table
MAX_BACK_CORNER_MISS = 0.05  # hidden-corner prediction vs silhouette, as a fraction of outline size
# Marker border softer than this (10-90 % rise / side) means a shaken or out-of-focus photo: in
# synthetic tests corner errors beyond ~2 % of the card side (about 1 cm on a 40 cm box) start here.
MAX_MARKER_BLUR = 0.10


@dataclass
class MarkerDetection:
    corners: np.ndarray  # 4x2 float, ArUco order (TL, TR, BR, BL)
    marker_id: int
    blur: float = 0.0  # widest 10-90 % edge rise of the marker border, as a fraction of its side
    edges: str = "ok"  # outcome of the edge-line refinement ("ok" = corners from fitted edge lines)


def _side_profiles(gray: np.ndarray, pts: np.ndarray, i: int, n_along: int):
    """Intensity profiles across marker side i (inside black border -> white card margin)."""
    center = pts.mean(axis=0)
    a, b = pts[i], pts[(i + 1) % 4]
    u = (b - a) / max(np.linalg.norm(b - a), 1e-9)
    nrm = np.array([-u[1], u[0]])
    if nrm @ ((a + b) / 2 - center) < 0:
        nrm = -nrm
    # The black border is 1/6 of the marker wide and the white margin 0.15 of it; stay within both,
    # measured perpendicular to this side so foreshortened (oblique) views are handled fairly.
    opposite = (pts[(i + 2) % 4] + pts[(i + 3) % 4]) / 2
    reach = max(2.0, 0.12 * abs(float((opposite - a) @ nrm)))
    offsets = np.linspace(-reach, reach, 41)
    along = a[None, :] + np.linspace(0.2, 0.8, n_along)[:, None] * (b - a)[None, :]
    grid = along[:, None, :] + offsets[None, :, None] * nrm[None, None, :]
    prof = cv2.remap(
        gray, grid[..., 0].astype(np.float32), grid[..., 1].astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    ).astype(np.float64)
    return along, nrm, offsets, prof


def _crossing(norm: np.ndarray, offsets: np.ndarray, level: float) -> float | None:
    mono = np.maximum.accumulate(norm)
    if mono[0] > level or mono[-1] < level:
        return None
    return float(np.interp(level, mono, offsets))


def refine_by_edges(gray: np.ndarray, corners: np.ndarray) -> tuple[np.ndarray, float, str]:
    """Re-locate the marker corners as intersections of lines fitted to its four border edges.

    The 50 % crossing of a straight edge does not move under symmetric blur, whereas corner
    detectors are pulled inwards as blur rounds the corner off; this keeps the card scale right
    in soft or slightly shaken photos. Also returns the blur estimate: the widest 10-90 % edge
    rise as a fraction of the mean marker side (sharp photo ~0.02; 0 when it cannot be measured),
    and a status: "ok" when the corners come from the fitted lines, otherwise why they do not.
    """
    pts = np.asarray(corners, dtype=np.float64)
    side = float(np.mean(np.linalg.norm(pts - np.roll(pts, 1, axis=0), axis=1)))
    if side < 8:
        return pts, 0.0, "small"
    lines, blur = [], 0.0
    for i in range(4):
        along, nrm, offsets, prof = _side_profiles(gray, pts, i, 24)
        mean = prof.mean(axis=0)
        lo, hi = float(mean[:4].mean()), float(mean[-4:].mean())
        if hi - lo < 10:
            return pts, 0.0, "contrast"
        x10 = _crossing((mean - lo) / (hi - lo), offsets, 0.1)
        x90 = _crossing((mean - lo) / (hi - lo), offsets, 0.9)
        if x10 is None or x90 is None:
            return pts, 0.0, "profile"
        blur = max(blur, (x90 - x10) / side)
        edge_pts = []
        for k in range(len(along)):
            p_lo, p_hi = float(prof[k, :4].mean()), float(prof[k, -4:].mean())
            if p_hi - p_lo < 10:
                continue
            x = _crossing((prof[k] - p_lo) / (p_hi - p_lo), offsets, 0.5)
            if x is not None:
                edge_pts.append(along[k] + x * nrm)
        if len(edge_pts) < 8:
            return pts, blur, "few-points"
        vx, vy, x0, y0 = cv2.fitLine(np.array(edge_pts, np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((np.array([x0, y0], np.float64), np.array([vx, vy], np.float64)))
    out = pts.copy()
    for i in range(4):
        # Corner i joins side i-1 (from corner i-1) and side i (to corner i+1).
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        A = np.array([d1, -d2]).T
        if abs(np.linalg.det(A)) < 1e-6:
            return pts, blur, "parallel"
        s, _ = np.linalg.solve(A, p2 - p1)
        out[i] = p1 + s * d1
    if np.max(np.linalg.norm(out - pts, axis=1)) > max(3.0, 0.15 * side):
        return pts, blur, "moved"
    return out, blur, "ok"


def _detector() -> cv2.aruco.ArucoDetector:
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    params.cornerRefinementWinSize = 5
    params.cornerRefinementMaxIterations = 50
    params.cornerRefinementMinAccuracy = 0.01
    return cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), params)


def find_marker(bgr: np.ndarray) -> MarkerDetection | None:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    scale = min(1.0, DETECT_MAX_SIDE / max(h, w))
    work = gray if scale == 1.0 else cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    corners, ids, _ = _detector().detectMarkers(work)
    if ids is None:
        return None
    ours = [c.reshape(4, 2).astype(np.float64) for c, i in zip(corners, ids.ravel()) if int(i) == MARKER_ID]
    # Several cards in view: use the one seen largest (most pixels, most precise corners).
    ours.sort(key=lambda p: -abs(cv2.contourArea(p.astype(np.float32))))
    for pts in ours[:1]:
        if scale != 1.0:
            pts = (pts + 0.5) / scale - 0.5
            side = float(np.mean(np.linalg.norm(pts - np.roll(pts, 1, axis=0), axis=1)))
            win = int(max(3, min(15, side / 20)))
            refined = pts.astype(np.float32).reshape(-1, 1, 2)
            cv2.cornerSubPix(
                gray, refined, (win, win), (-1, -1), (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.01)
            )
            pts = refined.reshape(4, 2).astype(np.float64)
        pts, blur, status = refine_by_edges(gray, pts)
        return MarkerDetection(pts, MARKER_ID, blur, status)
    return None


def _label_hexagon(hexagon: np.ndarray) -> np.ndarray | None:
    """Order silhouette vertices as [B1, B2, B3, T1, T3, Tback]."""
    n = len(hexagon)
    b2 = int(np.argmax(hexagon[:, 1]))
    prev_i, next_i = (b2 - 1) % n, (b2 + 1) % n
    if hexagon[prev_i, 0] < hexagon[next_i, 0]:
        b1, b3, step1 = prev_i, next_i, -1
    else:
        b1, b3, step1 = next_i, prev_i, 1
    t1 = (b1 + step1) % n
    t3 = (b3 - step1) % n
    back = [i for i in range(n) if i not in (b1, b2, b3, t1, t3)]
    if len(back) != 1:
        return None
    return hexagon[[b1, b2, b3, t1, t3, back[0]]]


def _hexagon(hull: np.ndarray) -> np.ndarray | None:
    """Reduce a convex hull to 6 vertices by repeatedly dropping the vertex that removes the least area."""
    pts = [p for p in hull.reshape(-1, 2).astype(np.float64)]
    if len(pts) < 6:
        return None

    def tri_area(a, b, c) -> float:
        return abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2

    while len(pts) > 6:
        n = len(pts)
        areas = [tri_area(pts[i - 1], pts[i], pts[(i + 1) % n]) for i in range(n)]
        pts.pop(int(np.argmin(areas)))
    poly = np.array(pts)
    total = cv2.contourArea(hull)
    if total <= 0 or cv2.contourArea(poly.astype(np.float32)) < 0.97 * total:
        return None
    return poly


def _refine_polygon(poly: np.ndarray, contour: np.ndarray) -> np.ndarray:
    """Fit a line to the contour points along each side and intersect neighbouring lines."""
    pts = contour.reshape(-1, 2).astype(np.float64)
    n = len(poly)
    lines = []
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ab = b - a
        length = np.linalg.norm(ab)
        if length < 1e-6:
            return poly
        u = ab / length
        rel = pts - a
        along = rel @ u
        across = np.abs(rel @ np.array([-u[1], u[0]]))
        sel = pts[(along > 0.15 * length) & (along < 0.85 * length) & (across < 3.0)]
        if len(sel) < 5:
            lines.append((a, u))
            continue
        vx, vy, x0, y0 = cv2.fitLine(sel.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((np.array([x0, y0], dtype=np.float64), np.array([vx, vy], dtype=np.float64)))
    out = poly.copy()
    for i in range(n):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        A = np.array([d1, -d2]).T
        if abs(np.linalg.det(A)) < 1e-6:
            continue
        s, _ = np.linalg.solve(A, p2 - p1)
        cand = p1 + s * d1
        if np.linalg.norm(cand - poly[i]) < 12.0:
            out[i] = cand
    return out


def _vertical_ok(base_px: np.ndarray, top_px: np.ndarray, base_cam: np.ndarray, n: np.ndarray, K: np.ndarray) -> bool:
    up_px = project((base_cam + 50.0 * n)[None], K)[0] - base_px
    seg = top_px - base_px
    if np.linalg.norm(seg) < 5 or np.linalg.norm(up_px) < 1e-6:
        return False
    cosang = float(seg @ up_px / (np.linalg.norm(seg) * np.linalg.norm(up_px)))
    return cosang > np.cos(np.radians(MAX_VERTICAL_DEVIATION_DEG))


def _upward_normal(pose: Pose) -> np.ndarray:
    n = pose.normal
    return n if float(n @ (-pose.tvec)) > 0 else -n


# Edge-map variants tried in order: (Canny low, Canny high, closing kernel, closing iterations).
# The first is tuned for sharp photos; the others recover softer silhouettes (blur, low resolution,
# grey or low-contrast boxes). A candidate is only accepted if it passes the 3-D checks below.
EDGE_VARIANTS = ((20, 50, 5, 2), (8, 24, 5, 2), (8, 24, 9, 2))


def _edge_map(blurred_lab: list[np.ndarray], lo: int, hi: int, k: int, iters: int) -> np.ndarray:
    edges = np.zeros(blurred_lab[0].shape, np.uint8)
    for ch in blurred_lab:
        edges |= cv2.Canny(ch, lo, hi)
    return cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8), iterations=iters)


def _largest_silhouette(edges: np.ndarray, card_px: np.ndarray, marker_center: np.ndarray) -> np.ndarray | None:
    cv2.fillConvexPoly(edges, np.round(card_px).astype(np.int32), 0)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    min_area = 0.004 * edges.shape[0] * edges.shape[1]
    max_area = 0.85 * edges.shape[0] * edges.shape[1]
    best, best_area = None, 0.0
    for c in contours:
        hull = cv2.convexHull(c)
        area = cv2.contourArea(hull)
        if area < min_area or area > max_area:
            continue
        if cv2.pointPolygonTest(hull, (float(marker_center[0]), float(marker_center[1])), False) >= 0:
            continue
        if area > best_area:
            best, best_area = c, area
    return best


def _box_from_contour(contour: np.ndarray, scale: float, K: np.ndarray, pose: Pose) -> np.ndarray | None:
    hexagon = _hexagon(cv2.convexHull(contour))
    if hexagon is None:
        return None
    hexagon = _refine_polygon(hexagon, contour) / scale
    labelled = _label_hexagon(hexagon)
    if labelled is None:
        return None
    b1, b2, b3, t1, t3, t_back = labelled

    n = _upward_normal(pose)
    try:
        cam = [table_point(p, K, pose) for p in (b1, b2, b3)]
    except GeometryError:
        return None
    if not (_vertical_ok(b1, t1, cam[0], n, K) and _vertical_ok(b3, t3, cam[2], n, K)):
        return None
    h1, _ = solve_height(cam[0], n, t1, K)
    h3, _ = solve_height(cam[2], n, t3, K)
    if h1 <= 20 or h3 <= 20 or abs(h1 - h3) > 0.35 * max(h1, h3):
        return None
    e1, e3 = cam[0] - cam[1], cam[2] - cam[1]
    if np.linalg.norm(e1) < 30 or np.linalg.norm(e3) < 30:
        return None
    # A carton is rectangular: the two bottom edges meet at ~90 degrees on the table.
    cos_b2 = float(e1 @ e3 / (np.linalg.norm(e1) * np.linalg.norm(e3)))
    if abs(cos_b2) > np.sin(np.radians(MAX_CORNER_ANGLE_DEVIATION_DEG)):
        return None
    h = (h1 + h3) / 2
    top = [c + h * n for c in cam]
    t2 = project(top[1][None], K)[0]
    # The sixth silhouette vertex must be where the box's back top corner projects.
    back = project((top[0] + top[2] - top[1])[None], K)[0]
    size = float(np.linalg.norm(hexagon.max(axis=0) - hexagon.min(axis=0)))
    if np.linalg.norm(back - t_back) > max(6.0, MAX_BACK_CORNER_MISS * size):
        return None
    return np.array([b1, b2, b3, t1, t2, t3])


def auto_box(bgr: np.ndarray, marker: np.ndarray, intr: Intrinsics, pose: Pose) -> np.ndarray | None:
    h, w = bgr.shape[:2]
    # Work at a fixed size so kernel sizes mean the same thing for 640 px and 12 MP photos.
    scale = BOX_MAX_SIDE / max(h, w)
    if scale == 1.0:
        small = bgr
    else:
        small = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    lab = cv2.split(cv2.cvtColor(cv2.GaussianBlur(small, (5, 5), 0), cv2.COLOR_BGR2LAB))

    K = intr.matrix()
    try:
        card = np.array([table_point(marker[i], K, pose) - pose.tvec for i in range(4)])
    except GeometryError:
        return None
    card_px = project(pose.tvec + 1.4 * card, K) * scale
    marker_center = marker.mean(axis=0) * scale

    for lo, hi, k, iters in EDGE_VARIANTS:
        contour = _largest_silhouette(_edge_map(lab, lo, hi, k, iters), card_px, marker_center)
        if contour is None:
            continue
        pts = _box_from_contour(contour, scale, K, pose)
        if pts is not None:
            return pts
    return None


def default_box(w: int, h: int, marker: np.ndarray, intr: Intrinsics, pose: Pose | None) -> np.ndarray:
    """A plausible 30x20x20 cm box beside the card for the user to drag into place."""
    if pose is not None:
        try:
            pts = _default_box_3d(w, h, marker, intr, pose)
            if pts is not None:
                return pts
        except GeometryError:
            pass
    cx, cy = w / 2.0, h / 2.0
    s = 0.18 * min(w, h)
    return np.array(
        [
            [cx - 1.2 * s, cy + 0.3 * s],
            [cx, cy + 0.9 * s],
            [cx + 1.2 * s, cy + 0.3 * s],
            [cx - 1.2 * s, cy - 0.6 * s],
            [cx, cy],
            [cx + 1.2 * s, cy - 0.6 * s],
        ]
    )


def _default_box_3d(w: int, h: int, marker: np.ndarray, intr: Intrinsics, pose: Pose) -> np.ndarray | None:
    K = intr.matrix()
    R, t = pose.R, pose.tvec
    n = _upward_normal(pose)
    to_world = lambda pc: R.T @ (pc - t)  # noqa: E731
    to_cam = lambda pw: R @ pw + t  # noqa: E731
    camera_world = to_world(np.zeros(3))

    center = to_world(table_point(np.array([w / 2.0, h / 2.0]), K, pose))[:2]
    if np.linalg.norm(center) < 250:
        direction = center if np.linalg.norm(center) > 1e-3 else np.array([1.0, 0.0])
        center = direction / np.linalg.norm(direction) * 300.0

    for size in (1.0, 0.75, 0.55, 0.4):
        L, W, H = 300 * size, 200 * size, 200 * size
        base = [
            center + np.array([-L / 2, -W / 2]),
            center + np.array([L / 2, -W / 2]),
            center + np.array([L / 2, W / 2]),
            center + np.array([-L / 2, W / 2]),
        ]
        bottoms = [np.array([p[0], p[1], 0.0]) for p in base]
        b2 = int(np.argmin([np.linalg.norm(camera_world - b) for b in bottoms]))
        na, nb = (b2 - 1) % 4, (b2 + 1) % 4
        cams = [to_cam(b) for b in bottoms]
        px = project(np.array(cams), K)
        b1, b3 = (na, nb) if px[na][0] < px[nb][0] else (nb, na)
        order = [b1, b2, b3]
        bottom_cam = np.array([cams[i] for i in order])
        top_cam = bottom_cam + H * n
        pts = project(np.vstack([bottom_cam, top_cam]), K)
        if np.all(bottom_cam[:, 2] > 0) and np.all(top_cam[:, 2] > 0):
            inside = (pts[:, 0] >= 0) & (pts[:, 0] < w) & (pts[:, 1] >= 0) & (pts[:, 1] < h)
            if inside.all():
                return pts
    return None


def suggest_box(bgr: np.ndarray, marker: np.ndarray, intr: Intrinsics) -> tuple[np.ndarray, bool]:
    """Returns (points, detected_automatically)."""
    h, w = bgr.shape[:2]
    poses = marker_poses(marker, intr.matrix())
    for pose in poses[:1]:
        try:
            pts = auto_box(bgr, marker, intr, pose)
        except (GeometryError, cv2.error, np.linalg.LinAlgError):
            pts = None
        if pts is not None:
            return pts, True
    return default_box(w, h, marker, intr, poses[0] if poses else None), False


def warm_up() -> None:
    """Run the detector once at start-up so the first real request does not pay OpenCV's lazy init."""
    side = 240
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    img = np.full((480, 640), 255, np.uint8)
    img[120 : 120 + side, 200 : 200 + side] = cv2.aruco.generateImageMarker(dictionary, MARKER_ID, side)
    find_marker(cv2.cvtColor(img, cv2.COLOR_GRAY2BGR))
