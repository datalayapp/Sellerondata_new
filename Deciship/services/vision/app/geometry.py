"""Camera geometry for the reference-card measurement.

World frame (millimetres): origin at the marker centre, X along the marker's
top edge (left to right), Y from the marker's bottom edge towards its top edge,
Z = X x Y pointing up out of the table towards the camera. Camera frame follows
OpenCV (x right, y down, z forward).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

MARKER_SIZE_MM = 100.0
DEFAULT_FOCAL_FACTOR = 0.8
FOCAL_MIN_FACTOR = 0.35
FOCAL_MAX_FACTOR = 4.0
FULL_FRAME_DIAGONAL_MM = 43.2666

# ArUco corner order: top-left, top-right, bottom-right, bottom-left.
MARKER_OBJECT_POINTS = np.array(
    [
        [-MARKER_SIZE_MM / 2, MARKER_SIZE_MM / 2, 0.0],
        [MARKER_SIZE_MM / 2, MARKER_SIZE_MM / 2, 0.0],
        [MARKER_SIZE_MM / 2, -MARKER_SIZE_MM / 2, 0.0],
        [-MARKER_SIZE_MM / 2, -MARKER_SIZE_MM / 2, 0.0],
    ],
    dtype=np.float64,
)


class GeometryError(ValueError):
    """Raised when the inputs cannot describe a box on the table."""


@dataclass
class Intrinsics:
    fx: float
    fy: float
    cx: float
    cy: float
    source: str

    def matrix(self) -> np.ndarray:
        return np.array([[self.fx, 0, self.cx], [0, self.fy, self.cy], [0, 0, 1]], dtype=np.float64)

    def with_focal(self, f: float, source: str | None = None) -> "Intrinsics":
        return Intrinsics(f, f, self.cx, self.cy, source or self.source)

    def to_json(self) -> dict:
        return {
            "fx": round(self.fx, 2),
            "fy": round(self.fy, 2),
            "cx": round(self.cx, 2),
            "cy": round(self.cy, 2),
            "source": self.source,
        }


@dataclass
class Pose:
    rvec: np.ndarray
    tvec: np.ndarray
    reprojection_px: float
    R: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.R, _ = cv2.Rodrigues(self.rvec)
        self.tvec = self.tvec.reshape(3)

    @property
    def normal(self) -> np.ndarray:
        """Table normal (world +Z) expressed in the camera frame."""
        return self.R[:, 2].copy()

    @property
    def camera_height_mm(self) -> float:
        return float(-(self.R.T @ self.tvec)[2])

    def world_to_camera(self, pts: np.ndarray) -> np.ndarray:
        return (self.R @ np.asarray(pts, dtype=np.float64).T).T + self.tvec


def default_intrinsics(w: int, h: int) -> Intrinsics:
    f = DEFAULT_FOCAL_FACTOR * max(w, h)
    return Intrinsics(f, f, w / 2.0, h / 2.0, "default")


def intrinsics_from_35mm(f35: float, w: int, h: int) -> Intrinsics:
    f = float(f35) * float(np.hypot(w, h)) / FULL_FRAME_DIAGONAL_MM
    return Intrinsics(f, f, w / 2.0, h / 2.0, "exif")


def focal_from_marker(corners: np.ndarray, w: int, h: int) -> float | None:
    """Single-view focal length from the marker homography.

    Assumes square pixels and the principal point at the image centre; the two
    rotation constraints (r1 . r2 = 0, |r1| = |r2|) then give a linear equation
    in 1/f^2 each, solved in the least-squares sense.
    """
    img = np.asarray(corners, dtype=np.float64).reshape(4, 2) - np.array([w / 2.0, h / 2.0])
    H = cv2.getPerspectiveTransform(MARKER_OBJECT_POINTS[:, :2].astype(np.float32), img.astype(np.float32))
    H = H / np.linalg.norm(H)
    h1, h2 = H[:, 0], H[:, 1]
    a = np.array([h1[0] * h2[0] + h1[1] * h2[1], h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2])
    b = np.array([h1[2] * h2[2], h1[2] ** 2 - h2[2] ** 2])
    # a * (1/f^2) + b = 0. Perspective terms (b) must be large enough to be informative.
    if np.linalg.norm(b) < 1e-12:
        return None
    inv_f2 = -float(a @ b) / float(a @ a)
    if inv_f2 <= 0:
        return None
    f = 1.0 / np.sqrt(inv_f2)
    m = max(w, h)
    # Weakly constrained when the marker is seen almost frontally.
    tilt_signal = np.linalg.norm(b) * f**2 / max(np.linalg.norm(a), 1e-12)
    if not (FOCAL_MIN_FACTOR * m <= f <= FOCAL_MAX_FACTOR * m) or tilt_signal < 0.05:
        return None
    return f


def estimate_intrinsics(corners: np.ndarray | None, w: int, h: int, exif_f35: float | None) -> Intrinsics:
    if exif_f35 and exif_f35 > 0:
        return intrinsics_from_35mm(exif_f35, w, h)
    if corners is not None:
        f = focal_from_marker(corners, w, h)
        if f is not None:
            return Intrinsics(f, f, w / 2.0, h / 2.0, "estimated")
    return default_intrinsics(w, h)


def marker_poses(corners: np.ndarray, K: np.ndarray) -> list[Pose]:
    img = np.asarray(corners, dtype=np.float64).reshape(4, 1, 2)
    n, rvecs, tvecs, errs = cv2.solvePnPGeneric(
        MARKER_OBJECT_POINTS, img, K, None, flags=cv2.SOLVEPNP_IPPE_SQUARE
    )
    poses = []
    for i in range(n):
        p = Pose(rvecs[i], tvecs[i], float(np.ravel(errs)[i]) if errs is not None else 0.0)
        if p.tvec[2] > 0 and p.camera_height_mm > 0:
            poses.append(p)
    poses.sort(key=lambda p: p.reprojection_px)
    return poses


def project(points_cam: np.ndarray, K: np.ndarray) -> np.ndarray:
    p = (K @ np.asarray(points_cam, dtype=np.float64).T).T
    return p[:, :2] / p[:, 2:3]


def table_point(px: np.ndarray, K: np.ndarray, pose: Pose) -> np.ndarray:
    """Intersect the viewing ray of pixel `px` with the table plane (camera frame)."""
    d = np.linalg.solve(K, np.array([px[0], px[1], 1.0]))
    n = pose.normal
    denom = float(n @ d)
    if abs(denom) < 1e-9:
        raise GeometryError("ray parallel to table")
    lam = float(n @ pose.tvec) / denom
    if lam <= 0:
        raise GeometryError("point is above the horizon")
    return lam * d


def solve_height(base: np.ndarray, n: np.ndarray, target: np.ndarray, K: np.ndarray) -> tuple[float, float]:
    """Least-squares h so that project(base + h*n) hits `target`. Returns (h, residual_px)."""
    p0 = K @ base
    d = K @ n
    a = d[:2] - target * d[2]
    b = target * p0[2] - p0[:2]
    h = float(a @ b) / max(float(a @ a), 1e-12)
    for _ in range(5):
        num = p0[:2] + h * d[:2]
        den = p0[2] + h * d[2]
        if den <= 1e-6:
            break
        r = num / den - target
        J = (d[:2] * den - num * d[2]) / den**2
        jj = float(J @ J)
        if jj < 1e-18:
            break
        step = float(J @ r) / jj
        h -= step
        if abs(step) < 1e-6:
            break
    pt = project((base + h * n)[None], K)[0]
    return h, float(np.linalg.norm(pt - target))


def robust_mean(values: list[float]) -> tuple[float, list[int]]:
    v = np.asarray(values, dtype=np.float64)
    med = float(np.median(v))
    tol = max(10.0, 0.08 * abs(med))
    keep = [i for i, x in enumerate(v) if abs(x - med) <= tol]
    if not keep:
        keep = list(range(len(v)))
    return float(np.mean(v[keep])), keep


@dataclass
class BoxSolution:
    length_mm: float
    width_mm: float
    height_mm: float
    heights_mm: list[float]
    kept: list[int]
    top_residual_px: list[float]
    angle_b2_deg: float
    marker_reproj_px: float
    pose: Pose
    intrinsics: Intrinsics
    bottoms_cam: np.ndarray

    @property
    def cost(self) -> float:
        return box_cost(self)


def box_cost(s: BoxSolution) -> float:
    angle_dev = s.angle_b2_deg - 90.0
    return 4 * s.marker_reproj_px**2 + float(np.sum(np.square(s.top_residual_px))) + 0.5 * angle_dev**2


def solve_box_with_pose(points: np.ndarray, pose: Pose, intr: Intrinsics) -> BoxSolution:
    K = intr.matrix()
    pts = np.asarray(points, dtype=np.float64).reshape(6, 2)
    bottoms = np.array([table_point(pts[i], K, pose) for i in range(3)])
    n = pose.normal
    if float(n @ (-pose.tvec)) < 0:
        n = -n
    heights, residuals = [], []
    for i in range(3):
        h, r = solve_height(bottoms[i], n, pts[3 + i], K)
        heights.append(h)
        residuals.append(r)
    height, kept = robust_mean(heights)
    v1 = bottoms[0] - bottoms[1]
    v2 = bottoms[2] - bottoms[1]
    L = float(np.linalg.norm(v1))
    W = float(np.linalg.norm(v2))
    if L < 1e-6 or W < 1e-6:
        raise GeometryError("degenerate base")
    angle = float(np.degrees(np.arccos(np.clip(v1 @ v2 / (L * W), -1, 1))))
    return BoxSolution(L, W, height, heights, kept, residuals, angle, pose.reprojection_px, pose, intr, bottoms)


def solve_box(points: np.ndarray, corners: np.ndarray, intr: Intrinsics) -> BoxSolution:
    poses = marker_poses(corners, intr.matrix())
    best: BoxSolution | None = None
    for pose in poses:
        try:
            s = solve_box_with_pose(points, pose, intr)
        except GeometryError:
            continue
        if s.height_mm <= 0:
            continue
        if best is None or s.cost < best.cost:
            best = s
    if best is None:
        raise GeometryError("no valid pose")
    return best


def refine_focal(points: np.ndarray, corners: np.ndarray, base: Intrinsics, w: int, h: int) -> BoxSolution:
    """Choose the focal length that makes the marker square and the box a right cuboid.

    Searches log-spaced focal values around plausible phone cameras, scoring marker
    reprojection, vertical-edge consistency and the right angle at B2.
    """
    m = max(w, h)
    candidates = np.exp(np.linspace(np.log(0.45 * m), np.log(2.6 * m), 90))
    best: BoxSolution | None = None

    def evaluate(f: float) -> BoxSolution | None:
        try:
            return solve_box(points, corners, base.with_focal(f, "estimated"))
        except GeometryError:
            return None

    for f in candidates:
        s = evaluate(float(f))
        if s is not None and (best is None or s.cost < best.cost):
            best = s
    if best is None:
        raise GeometryError("no valid pose")
    # Golden-section refinement in log-space around the best grid value.
    step = float(np.log(candidates[1]) - np.log(candidates[0]))
    lo, hi = np.log(best.intrinsics.fx) - step, np.log(best.intrinsics.fx) + step
    g = (np.sqrt(5) - 1) / 2

    def cost_at(lf: float) -> float:
        s = evaluate(float(np.exp(lf)))
        return float("inf") if s is None else s.cost

    c, d = hi - g * (hi - lo), lo + g * (hi - lo)
    fc, fd = cost_at(c), cost_at(d)
    for _ in range(30):
        if fc < fd:
            hi, d, fd = d, c, fc
            c = hi - g * (hi - lo)
            fc = cost_at(c)
        else:
            lo, c, fc = c, d, fd
            d = lo + g * (hi - lo)
            fd = cost_at(d)
    s = evaluate(float(np.exp((lo + hi) / 2)))
    if s is not None and s.cost <= best.cost:
        best = s
    return best


def confidence(s: BoxSolution, fit_rms_px: float | None = None) -> float:
    def clamp(x: float) -> float:
        return float(min(1.0, max(0.0, x)))

    s_reproj = clamp(1 - max(0.0, s.marker_reproj_px - 0.5) / 3.0)
    s_angle = clamp(1 - abs(s.angle_b2_deg - 90.0) / 20.0)
    hs = np.asarray(s.heights_mm)
    spread = float(hs.max() - hs.min())
    s_height = clamp(1 - spread / max(0.25 * s.height_mm, 20.0))
    s_vert = clamp(1 - float(np.sqrt(np.mean(np.square(s.top_residual_px)))) / 12.0)
    score = 0.2 * s_reproj + 0.3 * s_angle + 0.3 * s_height + 0.2 * s_vert
    if fit_rms_px is not None:
        score *= 0.7 + 0.3 * clamp(1 - max(0.0, fit_rms_px - 1.5) / 8.0)
    if s.intrinsics.source == "default":
        score *= 0.85
    return round(score, 2)


MARKER_SIGMA_PX = 0.3
POINT_SIGMA_PX = 1.5


@dataclass
class FittedBox:
    length_mm: float
    width_mm: float
    height_mm: float
    focal_px: float
    point_rms_px: float
    marker_rms_px: float


def _box_points_world(p: np.ndarray, side: float) -> np.ndarray:
    x, y, phi, L, W, H = p
    b2 = np.array([x, y, 0.0])
    u = np.array([np.cos(phi), np.sin(phi), 0.0])
    v = side * np.array([-np.sin(phi), np.cos(phi), 0.0])
    bottoms = np.array([b2 + L * u, b2, b2 + W * v])
    return np.vstack([bottoms, bottoms + np.array([0.0, 0.0, H])])


def fit_cuboid(points: np.ndarray, corners: np.ndarray, init: BoxSolution, fix_focal: bool) -> FittedBox | None:
    """Joint least-squares fit of camera pose, focal length and a right cuboid on the table.

    Uses the marker corners (sigma ~0.3 px) and the six user points (sigma ~1.5 px).
    """
    pose, intr = init.pose, init.intrinsics
    cx, cy = intr.cx, intr.cy
    pts = np.asarray(points, dtype=np.float64).reshape(6, 2)
    mk = np.asarray(corners, dtype=np.float64).reshape(4, 2)

    bw = (pose.R.T @ (init.bottoms_cam - pose.tvec).T).T
    u = bw[0] - bw[1]
    v = bw[2] - bw[1]
    side = 1.0 if (u[0] * v[1] - u[1] * v[0]) > 0 else -1.0
    phi = float(np.arctan2(u[1], u[0]))
    box0 = np.array([bw[1][0], bw[1][1], phi, init.length_mm, init.width_mm, init.height_mm])
    x0 = np.concatenate([pose.rvec.ravel(), pose.tvec.ravel(), box0, [np.log(intr.fx)]])
    n_free = 12 if fix_focal else 13

    def residuals(x: np.ndarray) -> np.ndarray:
        R, _ = cv2.Rodrigues(x[0:3])
        t = x[3:6]
        f = float(np.exp(x[12]))
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1.0]])
        pc_m = (R @ MARKER_OBJECT_POINTS.T).T + t
        pc_b = (R @ _box_points_world(x[6:12], side).T).T + t
        if np.any(pc_m[:, 2] <= 1) or np.any(pc_b[:, 2] <= 1):
            return np.full(20, 1e6)
        rm = (project(pc_m, K) - mk).ravel() / MARKER_SIGMA_PX
        rb = (project(pc_b, K) - pts).ravel() / POINT_SIGMA_PX
        return np.concatenate([rm, rb])

    x = x0.copy()
    r = residuals(x)
    cost = float(r @ r)
    lam = 1e-3
    for _ in range(100):
        J = np.empty((r.size, n_free))
        for j in range(n_free):
            dx = 1e-6 * max(1.0, abs(x[j]))
            xp = x.copy()
            xp[j] += dx
            J[:, j] = (residuals(xp) - r) / dx
        A = J.T @ J
        g = J.T @ r
        improved = False
        for _ in range(10):
            try:
                step = -np.linalg.solve(A + lam * np.diag(np.diag(A) + 1e-9), g)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            xn = x.copy()
            xn[:n_free] += step
            rn = residuals(xn)
            cn = float(rn @ rn)
            if cn < cost:
                x, r, lam, improved = xn, rn, max(lam / 3, 1e-9), True
                rel = (cost - cn) / max(cost, 1e-12)
                cost = cn
                break
            lam *= 10
        if not improved or rel < 1e-10:
            break

    L, W, H = x[9], x[10], x[11]
    if not np.all(np.isfinite(x)) or min(L, W, H) <= 0:
        return None
    res = r
    marker_rms = float(np.sqrt(np.mean(np.square(res[:8] * MARKER_SIGMA_PX))))
    point_rms = float(np.sqrt(np.mean(np.square(res[8:] * POINT_SIGMA_PX))))
    return FittedBox(float(L), float(W), float(H), float(np.exp(x[12])), point_rms, marker_rms)
