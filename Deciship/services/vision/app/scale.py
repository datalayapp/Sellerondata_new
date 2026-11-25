"""Free scale-display reader: seven-segment digits by classical image processing (no AI, no OCR engine).

Pipeline
1. Row search on a working copy (long side 1280): stroke response (black-hat for dark digits on a
   light window = LCD, top-hat on the brightest colour channel for bright digits on a dark window =
   LED) on a small pyramid, Otsu threshold, connected components, segments merged into digit-shaped
   groups, groups chained into rows of similar height. A row gives a centre, a digit height and a
   baseline angle.
2. Per row, at full resolution: crop, turn level, scale to a fixed digit height, measure the italic
   slant and remove it, then decode each digit cell by sampling the seven segment areas and the two
   hole centres. On/off is a two-class split of all samples of the row, so every segment gets a
   margin (how clearly it is on or off); one unclear segment refuses the whole reading.
3. Decimal point (small blob on the baseline inside a gap), minus sign, unit letters (kg / g / lb from
   the letter shapes: holes and descender), a missing-digit check left and right of the number,
   sanity rules (range, decimals, leading zeros), a confidence.
4. Rows are compared: two different numbers in one photo -> unreadable.

Anything that is not clearly a seven-segment number is refused ("okunamadı"): a wrong weight is
worse than none, because it would start a wrong carrier dispute. Nothing calls this yet; the
endpoint is behind SCALE_FREE_READ (default off) until it has been measured on real photos.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

MAX_KG = 300.0
ACCEPT_CONFIDENCE = 0.7
WORK_SIDE = 1280  # row search size
DIGIT_H = 64  # digit height of the normalised row crop
MAX_ROWS = 8  # rows decoded per photo
TIME_BUDGET_S = 4.0
MIN_MARGIN = 0.3  # each sample's distance from the on/off threshold, in half the on-off gap
MIN_CONTRAST = 0.3  # on-off gap of the row, in units of its strong stroke response
LB_TO_KG = 0.45359237

_GLYPHS = {
    "0": "abcdef",
    "1": "bc",
    "2": "abdeg",
    "3": "abcdg",
    "4": "bcfg",
    "5": "acdfg",
    "6": "acdefg",
    "7": "abc",
    "8": "abcdefg",
    "9": "abcdfg",
}
PATTERNS: dict[frozenset[str], str] = {frozenset(v): k for k, v in _GLYPHS.items()}
# Common alternative glyphs (6 without top bar, 7 with upper-left bar, 9 without bottom bar).
PATTERNS.update({frozenset("cdefg"): "6", frozenset("abcf"): "7", frozenset("abcfg"): "9"})
MINUS = frozenset("g")
SEGS = "abcdefg"


# --- data ------------------------------------------------------------------------------------------


@dataclass
class Comp:
    x0: int
    y0: int
    x1: int  # exclusive
    y1: int  # exclusive
    area: int
    label: int

    @property
    def w(self) -> int:
        return self.x1 - self.x0

    @property
    def h(self) -> int:
        return self.y1 - self.y0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def thick(self) -> float:
        """Mean stroke width for a stroke-like blob (area / length)."""
        return self.area / max(self.w, self.h)


@dataclass
class Group:
    members: list[Comp]
    x0: int = 0
    y0: int = 0
    x1: int = 0
    y1: int = 0

    def __post_init__(self) -> None:
        self.x0 = min(c.x0 for c in self.members)
        self.y0 = min(c.y0 for c in self.members)
        self.x1 = max(c.x1 for c in self.members)
        self.y1 = max(c.y1 for c in self.members)

    @property
    def w(self) -> int:
        return self.x1 - self.x0

    @property
    def h(self) -> int:
        return self.y1 - self.y0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def labels(self) -> list[int]:
        return [c.label for c in self.members]


@dataclass
class Row:
    pol: str  # "dark" (LCD) | "bright" (LED)
    cx: float
    cy: float
    h: float  # digit height
    length: float  # along the row
    angle: float  # degrees, baseline slope (y down)
    n: int

    @property
    def score(self) -> float:
        return self.h * math.sqrt(self.n)

    def scaled(self, k: float) -> Row:
        return Row(self.pol, self.cx * k, self.cy * k, self.h * k, self.length * k, self.angle, self.n)


@dataclass
class Hyp:
    reason: str | None
    text: str = ""
    unit: str | None = None
    unit_assumed: bool = False
    weight_kg: float | None = None
    confidence: float = 0.0
    pol: str = ""
    info: dict = field(default_factory=dict)


@dataclass
class ScaleReading:
    ok: bool  # True only when a weight is returned (confidence >= threshold, every check passed)
    weight_kg: float | None  # only when ok
    unit: str | None  # unit as displayed: "kg" | "g" | "lb" | None
    unit_assumed: bool  # True when no unit was seen and kg was assumed from the decimals
    text: str  # number as displayed, e.g. "12.34" ("" if nothing decoded)
    confidence: float
    reason: str | None  # why not ok (code), None when ok
    candidate_kg: float | None  # best decoded weight that passed every check, regardless of confidence
    elapsed_ms: float
    rows: list[dict] = field(default_factory=list)


# --- image helpers ---------------------------------------------------------------------------------


def _response(gray: np.ndarray, pol: str, k: int) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    return cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT if pol == "dark" else cv2.MORPH_TOPHAT, kernel)


def _binarize(resp: np.ndarray, floor: float) -> np.ndarray:
    t, _ = cv2.threshold(resp, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return (resp > max(t, floor)).astype(np.uint8)


def _components(bw: np.ndarray, min_area: int, min_h: int = 2) -> tuple[np.ndarray, list[Comp]]:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bw, connectivity=8)
    keep = np.nonzero((stats[:, cv2.CC_STAT_AREA] >= min_area) & (stats[:, cv2.CC_STAT_HEIGHT] >= min_h))[0]
    comps = []
    for i in keep:
        if i == 0:
            continue
        x, y, w, h, a = (int(v) for v in stats[i])
        comps.append(Comp(x, y, x + w, y + h, a, int(i)))
    return labels, comps


def _group(comps: list[Comp], corner_tol: float = 0.25) -> list[Group]:
    """Merge segment blobs into digit blobs: stacked, horizontally overlapping, similar stroke width.

    corner_tol: how far apart (in stroke widths) two blobs may be horizontally and still join at a
    corner. The row search uses some slack (tilted photo); the decoder uses none, so a decimal point
    glued to one digit cannot bridge to the next one (cells come from the resp samples anyway)."""
    n = len(comps)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    order = sorted(range(n), key=lambda i: comps[i].x0)
    for ii, i in enumerate(order):
        a = comps[i]
        ta = a.thick
        for j in order[ii + 1 :]:
            b = comps[j]
            if b.x0 > a.x1 + 0.25 * ta:
                break
            tb = b.thick
            tol = corner_tol * min(ta, tb)
            ov = min(a.x1, b.x1) - max(a.x0, b.x0)
            if ov < -tol:
                continue
            # Side by side (not stacked, not a corner) needs a real overlap: a unit letter or a
            # neighbour touching a digit's bar is not part of it.
            if min(a.y1, b.y1) - max(a.y0, b.y0) > 0.6 * min(a.h, b.h) and ov < 0.5 * min(a.w, b.w):
                continue
            if not 0.4 <= ta / max(tb, 1e-6) <= 2.5:
                continue
            # A frame or panel edge is much bigger than a segment in both directions: never part of a digit.
            if (a.w > 2.2 * b.w and a.h > 2.2 * b.h) or (b.w > 2.2 * a.w and b.h > 2.2 * a.h):
                continue
            if max(a.y0, b.y0) - min(a.y1, b.y1) > 0.8 * max(ta, tb):
                continue
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[rj] = ri
    sets: dict[int, list[Comp]] = {}
    for i in range(n):
        sets.setdefault(find(i), []).append(comps[i])
    return [Group(m) for m in sets.values()]


def _fit_line(xs: list[float], ys: list[float], default: float) -> tuple[float, float]:
    """y = a + b x; flat at the median when there are not enough points."""
    if len(xs) >= 2 and max(xs) - min(xs) > 1e-3:
        b, a = np.polyfit(np.asarray(xs, float), np.asarray(ys, float), 1)
        return float(a), float(b)
    return (float(np.median(ys)) if ys else default), 0.0


def _runs(row: np.ndarray) -> list[int]:
    if row.size == 0:
        return []
    d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
    starts, ends = np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]
    return list(ends - starts)


class _Integral:
    def __init__(self, img: np.ndarray):
        self.ii = cv2.integral(img.astype(np.float64))
        self.h, self.w = img.shape[:2]

    def mean(self, r: tuple[float, float, float, float]) -> float | None:
        x0, y0, x1, y1 = r
        x0, y0 = int(math.floor(x0 + 0.5)), int(math.floor(y0 + 0.5))
        x1, y1 = max(int(math.floor(x1 + 0.5)), x0 + 1), max(int(math.floor(y1 + 0.5)), y0 + 1)
        if x0 < 0 or y0 < 0 or x1 > self.w or y1 > self.h:
            return None
        s = self.ii[y1, x1] - self.ii[y0, x1] - self.ii[y1, x0] + self.ii[y0, x0]
        return float(s) / ((x1 - x0) * (y1 - y0))


# --- stage 1: find digit rows ----------------------------------------------------------------------


def _chain(groups: list[Group], pol: str) -> list[Row]:
    cand = sorted((g for g in groups if g.h >= 10 and 0.08 * g.h <= g.w <= 1.1 * g.h), key=lambda g: g.x0)
    n = len(cand)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        a = cand[i]
        for j in range(i + 1, n):
            b = cand[j]
            if b.x0 > a.x1 + 1.2 * a.h:
                break
            hm = (a.h + b.h) / 2
            if not 0.75 <= a.h / b.h <= 1.33 or abs(a.cy - b.cy) > 0.25 * hm:
                continue
            if not -0.15 * hm <= b.x0 - a.x1 <= 1.1 * hm:
                continue
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[rj] = ri
    sets: dict[int, list[Group]] = {}
    for i in range(n):
        sets.setdefault(find(i), []).append(cand[i])
    rows = []
    for members in sets.values():
        if len(members) < 2 or len(members) > 12:
            continue
        hmax = max(m.h for m in members)
        full = [m for m in members if m.h >= 0.85 * hmax]
        _, slope = _fit_line([m.cx for m in full], [m.y1 for m in full], 0.0)
        angle = math.degrees(math.atan(slope))
        if abs(angle) > 30:
            continue
        x0, x1 = min(m.x0 for m in members), max(m.x1 for m in members)
        cx = (x0 + x1) / 2
        mcx = float(np.mean([m.cx for m in full]))
        cy = float(np.mean([m.cy for m in full])) + slope * (cx - mcx)
        h = float(np.median([m.h for m in full]))
        rows.append(Row(pol, cx, cy, h, (x1 - x0) / math.cos(math.radians(angle)), angle, len(members)))
    return rows


def _find_rows(dark: np.ndarray, bright: np.ndarray) -> list[Row]:
    rows: list[Row] = []
    for pol, g in (("dark", dark), ("bright", bright)):
        level = 1
        found: list[Row] = []
        while min(g.shape[:2]) >= 48 and level <= 8:
            resp = _response(cv2.GaussianBlur(g, (0, 0), 0.7), pol, 15)
            otsu, _ = cv2.threshold(resp, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            # Otsu follows the strongest strokes in the photo (printed text, bezel); a faint LCD
            # needs a lower cut as well.
            for cut in sorted({max(10.0, otsu), max(10.0, 0.45 * otsu)}):
                _, comps = _components((resp > cut).astype(np.uint8), 8, 3)
                if len(comps) <= 5000:
                    found += [r.scaled(level) for r in _chain(_group(comps), pol)]
            g = cv2.pyrDown(g)
            level *= 2
        # Same row seen at several pyramid levels: keep the best.
        found.sort(key=lambda r: -r.score)
        kept: list[Row] = []
        for r in found:
            if not any(math.hypot(r.cx - k.cx, r.cy - k.cy) < 0.6 * min(r.h, k.h) and 0.67 <= r.h / k.h <= 1.5 for k in kept):
                kept.append(r)
        rows += kept
    rows.sort(key=lambda r: -r.score)
    return rows


# --- stage 2: decode one row -----------------------------------------------------------------------


def _crop_row(gray: np.ndarray, row: Row) -> np.ndarray | None:
    """Row crop, turned level and scaled so the digits are DIGIT_H px tall; the row sits at mid height."""
    H, W = gray.shape[:2]
    h, L = row.h, row.length
    left, right, up = 1.9 * h, 3.6 * h, 1.1 * h
    s = DIGIT_H / h
    out_w, out_h = int(round((L + left + right) * s)), int(round(2 * up * s))
    if out_w > 4000 or out_w < 8:
        return None
    rad = 0.5 * math.hypot(L + left + right, 2 * up) * 1.05
    x0, x1 = max(0, int(row.cx - rad)), min(W, int(math.ceil(row.cx + rad)))
    y0, y1 = max(0, int(row.cy - rad)), min(H, int(math.ceil(row.cy + rad)))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    sub = gray[y0:y1, x0:x1]
    k = 1.0
    if s < 1.0:  # shrink first with area averaging: no aliasing of thin strokes
        nw, nh = max(1, int(round(sub.shape[1] * s))), max(1, int(round(sub.shape[0] * s)))
        k = nw / sub.shape[1]
        sub = cv2.resize(sub, (nw, nh), interpolation=cv2.INTER_AREA)
        c = ((row.cx - x0) * k, (row.cy - y0) * k)
        M = cv2.getRotationMatrix2D(c, row.angle, s / k)
    else:
        c = (row.cx - x0, row.cy - y0)
        M = cv2.getRotationMatrix2D(c, row.angle, s)
    M[0, 2] += (left + L / 2) * s - c[0]
    M[1, 2] += up * s - c[1]
    return cv2.warpAffine(sub, M, (out_w, out_h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


@dataclass
class _Ctx:
    img: np.ndarray
    resp: np.ndarray  # float, 1.0 = strong stroke
    bw: np.ndarray
    labels: np.ndarray
    comps: list[Comp]
    digits: list[Group]
    top: tuple[float, float]
    bottom: tuple[float, float]
    h: float

    def top_at(self, x: float) -> float:
        return self.top[0] + self.top[1] * x

    def bottom_at(self, x: float) -> float:
        return self.bottom[0] + self.bottom[1] * x


def _horizontal_slope(resp: np.ndarray, members: list[Group]) -> float:
    """dy/dx of the near-horizontal stroke edges inside the digits (weighted median)."""
    x0, x1 = max(0, min(g.x0 for g in members)), min(resp.shape[1], max(g.x1 for g in members))
    y0, y1 = max(0, min(g.y0 for g in members)), min(resp.shape[0], max(g.y1 for g in members))
    if x1 - x0 < 5 or y1 - y0 < 5:
        return 0.0
    r = cv2.GaussianBlur(resp[y0:y1, x0:x1].astype(np.float32), (0, 0), 1.0)
    gx = cv2.Sobel(r, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(r, cv2.CV_32F, 0, 1, ksize=3)
    ay = np.abs(gy)
    if float(ay.max()) <= 0:
        return 0.0
    sel = (ay > 0.3 * float(np.percentile(ay, 99))) & (np.abs(gx) < 0.5 * ay)
    if int(sel.sum()) < 20:
        return 0.0
    vals, w = -gx[sel] / gy[sel], ay[sel]
    order = np.argsort(vals)
    cw = np.cumsum(w[order])
    return float(vals[order][np.searchsorted(cw, cw[-1] / 2)])


def _split_wide(labels: np.ndarray, bw: np.ndarray, comps: list[Comp]) -> list[Comp]:
    """Blobs wider than a digit (two digits, or a digit and its decimal point, joined by glow or
    blur) are opened with a disc a little thinner than the strokes: bridges thinner than that
    vanish, strokes and the point stay. A digit that falls apart into segments is harmless:
    grouping joins them again. Updates `labels` in place with new ids for the pieces."""
    wide = [c for c in comps if c.w > 0.75 * DIGIT_H and c.h >= 0.3 * DIGIT_H]
    if not wide:
        return comps
    yc = bw.shape[0] // 2
    runs: list[int] = []
    for y in range(max(0, yc - int(0.4 * DIGIT_H)), min(bw.shape[0], yc + int(0.4 * DIGIT_H)), 2):
        runs += _runs(bw[y])
    t = float(np.median(runs)) if runs else 0.13 * DIGIT_H
    k = max(3, int(round(0.6 * t)) | 1)
    disc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    out = [c for c in comps if c not in wide]
    next_label = int(labels.max()) + 1
    for c in wide:
        sub = labels[c.y0 : c.y1, c.x0 : c.x1]
        mask = (sub == c.label).astype(np.uint8)
        opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, disc)
        n, lab = cv2.connectedComponents(opened, connectivity=8)
        if n <= 2:  # nothing to cut
            out.append(c)
            continue
        sub[mask > 0] = 0  # bridge pixels drop out
        for i in range(1, n):
            ys, xs = np.nonzero(lab == i)
            if xs.size < 4:
                continue
            sub[ys, xs] = next_label
            out.append(Comp(c.x0 + int(xs.min()), c.y0 + int(ys.min()), c.x0 + int(xs.max()) + 1, c.y0 + int(ys.max()) + 1, int(xs.size), next_label))
            next_label += 1
    return out


def _analyse(img: np.ndarray, pol: str) -> _Ctx | None:
    k = int(DIGIT_H * 0.55) | 1
    resp = _response(cv2.GaussianBlur(img, (0, 0), 0.8), pol, k)
    # Window frames and panel edges can respond far more strongly than a faint LCD: blank anything
    # bigger than a digit before taking the statistics, so the threshold follows the digits.
    otsu, _ = cv2.threshold(resp, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    big_labels, big = _components((resp > max(10.0, 0.5 * otsu)).astype(np.uint8), 6, 2)
    large = [c.label for c in big if c.h > 1.6 * DIGIT_H or c.w > 3 * DIGIT_H]
    if large:
        resp = resp.copy()
        resp[np.isin(big_labels, large)] = 0
    yc = img.shape[0] / 2
    band = resp[max(0, int(yc - 0.8 * DIGIT_H)) : int(yc + 0.8 * DIGIT_H)]
    scale = float(np.percentile(band, 99.5))
    if scale < 8:
        return None
    bw = _binarize(resp, max(10.0, 0.4 * scale))  # LED glow between digits stays below
    labels, comps = _components(bw, 6, 2)
    comps = [c for c in comps if c.h <= 1.6 * DIGIT_H and c.w <= 3 * DIGIT_H]  # window frames, panel edges
    comps = _split_wide(labels, bw, comps)
    groups = _group(comps, 0.0)
    cand = [g for g in groups if 0.4 * DIGIT_H <= g.h <= 1.8 * DIGIT_H and g.w <= 1.25 * g.h and abs(g.cy - yc) <= 0.5 * DIGIT_H]
    if not cand:
        return None
    # Reference height: the one most digits agree with (a "1" is ~0.8 of a full digit).
    best = max(cand, key=lambda g: (sum(1 for o in cand if 0.75 * g.h <= o.h <= 1.06 * g.h), g.h))
    members = [o for o in cand if 0.75 * best.h <= o.h <= 1.06 * best.h]
    mcy = float(np.median([m.cy for m in members]))
    members = sorted((m for m in members if abs(m.cy - mcy) <= 0.3 * best.h), key=lambda g: g.x0)
    if not members:
        return None
    hmax = max(m.h for m in members)
    # Tilt from the horizontal bar edges (digit outlines are a poor guide: 1 and 4 start lower, 7
    # ends higher, a touching decimal point hangs lower). The edge lines then go through the
    # outermost digit, which is the true top/bottom of the cells.
    slope = _horizontal_slope(resp, members)
    top = (float(min(m.y0 - slope * m.cx for m in members)), slope)
    bottom = (float(max(m.y1 - slope * m.cx for m in members)), slope)
    respf = resp.astype(np.float32) / scale
    return _Ctx(img, respf, bw, labels, comps, members, top, bottom, float(hmax))


def _angle(ctx: _Ctx) -> float:
    return math.degrees(math.atan((ctx.top[1] + ctx.bottom[1]) / 2))


def _rotate(img: np.ndarray, angle: float) -> np.ndarray:
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def _shear(img: np.ndarray, s: float, yc: float, interp=cv2.INTER_LINEAR) -> np.ndarray:
    """x' = x + s (y - yc): positive s straightens digits slanted to the right."""
    h, w = img.shape[:2]
    M = np.array([[1.0, s, -s * yc], [0.0, 1.0, 0.0]])
    return cv2.warpAffine(img, M, (w, h), flags=interp, borderMode=cv2.BORDER_REPLICATE)


def _estimate_shear(ctx: _Ctx) -> float:
    """Italic slant (x shift per px of height, positive = top to the right).

    From the orientation of the near-vertical edges of the digit strokes (gradient direction,
    weighted median): every vertical bar contributes two edges whether or not the segments of a
    digit touch each other. Edges more than ~26 degrees from vertical (bar tips, horizontal bars)
    are ignored."""
    xs0 = max(0, min(g.x0 for g in ctx.digits) - 2)
    xs1 = min(ctx.img.shape[1], max(g.x1 for g in ctx.digits) + 2)
    ys0 = max(0, int(min(g.y0 for g in ctx.digits)) - 2)
    ys1 = min(ctx.img.shape[0], int(max(g.y1 for g in ctx.digits)) + 2)
    labs = [lab for g in ctx.digits for lab in g.labels]
    near = cv2.dilate(np.isin(ctx.labels[ys0:ys1, xs0:xs1], labs).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    r = cv2.GaussianBlur(ctx.resp[ys0:ys1, xs0:xs1], (0, 0), 1.0)
    gx = cv2.Sobel(r, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(r, cv2.CV_32F, 0, 1, ksize=3)
    ax = np.abs(gx)
    if not near.any() or float(ax[near].max()) <= 0:
        return 0.0
    sel = near & (ax > 0.3 * float(np.percentile(ax[near], 99))) & (np.abs(gy) < 0.5 * ax)
    if int(sel.sum()) < 20:
        return 0.0
    vals, w = gy[sel] / gx[sel], ax[sel]
    order = np.argsort(vals)
    cw = np.cumsum(w[order])
    return float(vals[order][np.searchsorted(cw, cw[-1] / 2)])


def _split(values: list[float]) -> tuple[float, float]:
    """1-D two-class split (Otsu): (mean of the low class, mean of the high class)."""
    v = np.sort(np.asarray(values, float))
    n = v.size
    c = np.cumsum(v)
    best, lo, hi = -1.0, float(v[0]), float(v[-1])
    for k in range(1, n):
        m0, m1 = c[k - 1] / k, (c[-1] - c[k - 1]) / (n - k)
        between = (k / n) * (1 - k / n) * (m1 - m0) ** 2
        if between > best:
            best, lo, hi = between, float(m0), float(m1)
    return lo, hi


def _seg_rects(xr: float, ytop: float, ybot: float, W: float, t: float) -> dict[str, tuple[float, float, float, float]]:
    """Sampling rectangles (x0, y0, x1, y1) of the seven segments and two hole centres of one cell."""
    hh = ybot - ytop
    x0 = xr - W
    up_a, up_b = ytop + t, ytop + hh / 2 - t / 2
    lo_a, lo_b = ytop + hh / 2 + t / 2, ybot - t
    xl, xrr = x0 + t / 2, xr - t / 2

    def hor(yc: float):
        return (x0 + 0.3 * W, yc - 0.3 * t, xr - 0.3 * W, yc + 0.3 * t)

    def ver(xc: float, ya: float, yb: float):
        span = yb - ya
        return (xc - 0.3 * t, ya + 0.25 * span, xc + 0.3 * t, yb - 0.25 * span)

    hx0, hx1 = x0 + t + 0.25 * (W - 2 * t), xr - t - 0.25 * (W - 2 * t)
    return {
        "a": hor(ytop + t / 2),
        "g": hor(ytop + hh / 2),
        "d": hor(ybot - t / 2),
        "f": ver(xl, up_a, up_b),
        "b": ver(xrr, up_a, up_b),
        "e": ver(xl, lo_a, lo_b),
        "c": ver(xrr, lo_a, lo_b),
        "u": (hx0, up_a + 0.25 * (up_b - up_a), hx1, up_b - 0.25 * (up_b - up_a)),
        "l": (hx0, lo_a + 0.25 * (lo_b - lo_a), hx1, lo_b - 0.25 * (lo_b - lo_a)),
    }


def _holes(ctx: _Ctx, g: Group) -> list[float]:
    """Enclosed holes of a letter: centre height of each, 0 = top of the letter, 1 = bottom."""
    sub = np.isin(ctx.labels[g.y0 : g.y1, g.x0 : g.x1], g.labels).astype(np.uint8)
    sub = cv2.copyMakeBorder(sub, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    contours, hier = cv2.findContours(sub, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return []
    min_area = max(2.0, 0.015 * g.w * g.h)
    out = []
    for c, hi in zip(contours, hier[0]):
        if hi[3] != -1 and cv2.contourArea(c) >= min_area:
            ys = c[:, 0, 1].astype(float) - 1
            out.append(float((ys.min() + ys.max()) / 2 / max(g.h - 1, 1)))
    return out


def _letters(comps: list[Comp]) -> list[Group]:
    """Letters are single blobs, or blobs stacked almost exactly on top of each other."""
    out: list[list[Comp]] = []
    for c in sorted(comps, key=lambda c: c.x0):
        if out:
            prev = out[-1]
            px0, px1 = min(p.x0 for p in prev), max(p.x1 for p in prev)
            if min(px1, c.x1) - max(px0, c.x0) >= 0.6 * min(px1 - px0, c.w):
                prev.append(c)
                continue
        out.append([c])
    return [Group(m) for m in out]


def _unit(ctx: _Ctx, comps: list[Comp], r_last: float, W: float) -> tuple[str | None, list[Group]]:
    """kg / g / lb from the letter shapes right of the number (holes, descender), else None."""
    hh = ctx.h
    letters = []
    near = [c for c in comps if r_last + 0.05 * W <= c.x0 <= r_last + 2.6 * W and c.h >= 0.1 * hh]
    for g in _letters(near):
        if g.x0 < r_last + 0.05 * W or g.x0 > r_last + 2.6 * W:
            continue
        top, bot = ctx.top_at(g.cx), ctx.bottom_at(g.cx)
        if g.y0 < top - 0.1 * hh or g.y1 > bot + 0.6 * hh or g.y1 < top + 0.3 * hh:
            continue
        if not 0.2 * hh <= g.h <= 0.95 * hh:
            continue
        letters.append(g)
    letters.sort(key=lambda g: g.x0)
    chain: list[Group] = []
    for g in letters:
        if not chain:
            if g.x0 - r_last > 1.4 * W:
                break
        elif g.x0 - chain[-1].x1 > 0.5 * hh:
            break
        chain.append(g)
        if len(chain) == 3:
            break
    bot_line = ctx.bottom_at(r_last)
    if len(chain) == 2:
        a, b = chain
        ha, hb = _holes(ctx, a), _holes(ctx, b)
        if not ha and hb:
            # k + g: g starts lower (x-height) and hangs below k; its bowl is in its upper part.
            if b.y1 - a.y1 >= 0.2 * a.h and b.y0 >= a.y0 + 0.15 * a.h and min(hb) < 0.5:
                return "kg", chain
            # l + b: same top and bottom, l a narrow bar, the bowl of b in its lower part.
            if abs(b.y1 - a.y1) <= 0.12 * a.h and abs(b.y0 - a.y0) <= 0.15 * a.h and a.w <= 0.35 * a.h and max(hb) > 0.5:
                return "lb", chain
    elif len(chain) == 1:
        g = chain[0]
        hg = _holes(ctx, g)
        # g alone: a lowercase letter (starts well below the digit tops), bowl in its upper part,
        # tail reaching the digit baseline or below.
        top_line = ctx.top_at(g.cx)
        if hg and min(hg) < 0.45 and 0.4 <= g.w / g.h <= 1.0 and g.y0 >= top_line + 0.3 * hh and g.y1 >= bot_line - 0.05 * hh:
            return "g", chain
    return None, chain


def _reject(reason: str, pol: str, **info) -> Hyp:
    return Hyp(reason, pol=pol, info=info)


def _decode(crop: np.ndarray, pol: str) -> Hyp:
    img = crop
    ctx = _analyse(img, pol)
    if ctx is None:
        return _reject("no_digits", pol)
    ang = _angle(ctx)
    if abs(ang) > 0.5:
        img = _rotate(img, ang)
        ctx = _analyse(img, pol)
        if ctx is None:
            return _reject("no_digits", pol)
    s = _estimate_shear(ctx)
    if abs(s) > 0.01:
        img = _shear(img, s, img.shape[0] / 2)
        ctx = _analyse(img, pol)
        if ctx is None:
            return _reject("no_digits", pol)
    hyp = _read_row(ctx, pol)
    hyp.info["shear"] = round(s, 3)
    return hyp


def _read_row(ctx: _Ctx, pol: str) -> Hyp:
    hh = ctx.h
    # Stroke thickness from horizontal runs through the vertical segments.
    runs: list[int] = []
    for g in ctx.digits:
        sub = np.isin(ctx.labels[:, g.x0 : g.x1], g.labels)
        for frac in (0.27, 0.73):
            y = int(round(ctx.top_at(g.cx) + frac * (ctx.bottom_at(g.cx) - ctx.top_at(g.cx))))
            if 0 <= y < sub.shape[0]:
                runs += _runs(sub[y])
    t = float(np.median(runs)) if runs else 0.13 * hh
    t = min(max(t, 0.06 * hh), 0.3 * hh)

    # Pass 2: decimal-point candidates are kept out of the digit blobs, then regroup.
    def dot_like(c: Comp) -> bool:
        # Roughly square and solid; a bar of a "1" is at least ~1.8 times taller than wide.
        if max(c.w, c.h) > 2.0 * t or min(c.w, c.h) < 0.35 * t or not 0.62 <= c.w / c.h <= 1.6 or c.area < 0.4 * c.w * c.h:
            return False
        b = ctx.bottom_at(c.cx)
        return b - 0.45 * hh <= c.cy <= b + 0.3 * hh

    dots = [c for c in ctx.comps if dot_like(c)]
    dot_ids = {c.label for c in dots}
    groups = _group([c for c in ctx.comps if c.label not in dot_ids], 0.0)
    digits = []
    for g in groups:
        top, bot = ctx.top_at(g.cx), ctx.bottom_at(g.cx)
        in_band = g.y0 >= top - 0.15 * hh and g.y1 <= bot + 0.15 * hh
        at_border = g.x0 <= 1 or g.x1 >= ctx.img.shape[1] - 1  # window edge cut by the crop
        if in_band and g.h >= 0.55 * hh and not at_border:
            digits.append(g)
    digits.sort(key=lambda g: g.x0)
    # A number has no empty cell inside. A blob far from the rest (a window edge, a mark) is dropped;
    # one about two cells away could be a digit with a dead or unseen digit between: refuse.
    for end in (0, -1):
        while len(digits) >= 2:
            gap = abs(digits[end].x1 - digits[1 if end == 0 else -2].x1)
            if gap > 2.0 * hh:
                digits.pop(end)
            elif gap > 1.5 * hh:
                return _reject("missed_digit", pol)
            else:
                break
    if not digits:
        return _reject("no_digits", pol)
    if len(digits) > 7:
        return _reject("too_many_digits", pol)

    # Digit extent measured above the bottom bar, where a decimal point touching the digit (LED glow,
    # blur) cannot widen it; whatever sticks out at the bottom becomes a decimal-point candidate.
    spans: list[tuple[float, float]] = []
    for g in digits:
        mask = np.isin(ctx.labels[g.y0 : g.y1, g.x0 : g.x1], g.labels)
        ycut = int(round(ctx.bottom_at(g.cx) - 1.4 * t)) - g.y0
        cols = np.nonzero(mask[: max(ycut, 1)].any(axis=0))[0]
        if cols.size == 0:
            spans.append((float(g.x0), float(g.x1)))
            continue
        x0u, x1u = int(cols.min()), int(cols.max()) + 1
        spans.append((float(g.x0 + x0u), float(g.x0 + x1u)))
        low = mask[max(ycut, 0) :]
        for a, b in ((x1u + int(math.ceil(0.3 * t)), mask.shape[1]), (0, x0u - int(math.ceil(0.3 * t)))):
            if b - a < 1:
                continue
            ys, xs = np.nonzero(low[:, a:b])
            if xs.size:
                bx0, bx1 = g.x0 + a + int(xs.min()), g.x0 + a + int(xs.max()) + 1
                by0, by1 = g.y0 + max(ycut, 0) + int(ys.min()), g.y0 + max(ycut, 0) + int(ys.max()) + 1
                if max(bx1 - bx0, by1 - by0) <= 2.2 * t:
                    dots.append(Comp(bx0, by0, bx1, by1, int(xs.size), -1 - len(dots)))
    boxes = [(int(a), g.y0, int(b - a), g.h) for (a, b), g in zip(spans, digits)]
    if any(b - a > 1.0 * hh for a, b in spans):
        return _reject("merged_digits", pol, boxes=boxes)

    # Cell width: the widest digit (3 and 7 have no left bars and look narrower; 1 is a single bar).
    wide = [b - a for a, b in spans if b - a >= 0.33 * hh]
    W = float(max(wide)) if wide else 0.55 * hh
    if wide and W > 1.6 * float(np.median(wide)):
        return _reject("merged_digits", pol, boxes=boxes)
    rights = [b for _, b in spans]
    if len(rights) >= 2:
        diffs = np.diff(rights)
        P = float(np.median(diffs))
        if diffs.min() < 0.95 * W:
            return _reject("irregular_spacing", pol, boxes=boxes)
        if diffs.max() > 1.6 * P or not 1.0 * W <= P <= 1.9 * W:
            return _reject("missed_digit", pol, boxes=boxes)
        # Fixed pitch, allowing a linear change along the row (perspective).
        idx = np.arange(len(rights), dtype=float)
        fit = np.polyval(np.polyfit(idx, rights, 1), idx) if len(rights) >= 3 else np.asarray(rights)
        pitch_dev = float(np.max(np.abs(np.asarray(rights) - fit)) / P)
        if pitch_dev > 0.2 or float(np.max(np.abs(diffs - P)) / P) > 0.3:
            return _reject("irregular_spacing", pol, boxes=boxes)
    else:
        P, pitch_dev = 1.38 * W, 0.0

    R = _Integral(ctx.resp)
    B = _Integral(ctx.bw)

    # Local gain: glare or uneven light leaves some digits fainter than others. Each digit's samples
    # are scaled by its own stroke strength relative to the row; cells and gaps next to a digit use
    # the gain of the nearest digit.
    def strength(xr: float) -> float:
        xc = xr - W / 2
        y0, y1 = max(0, int(ctx.top_at(xc))), min(ctx.resp.shape[0], int(math.ceil(ctx.bottom_at(xc))))
        patch = ctx.resp[y0:y1, max(0, int(xr - W)) : min(ctx.resp.shape[1], int(math.ceil(xr)))]
        return float(np.percentile(patch, 97)) if patch.size else 0.0

    strengths = [strength(r) for r in rights]
    ref = float(np.median(strengths))
    if ref <= 0 or min(strengths) < 0.35 * ref:
        return _reject("low_contrast", pol)
    gains = [ref / v for v in strengths]
    centres = np.asarray(rights) - W / 2

    def gain_at(x: float) -> float:
        return gains[int(np.argmin(np.abs(centres - x)))]

    def mean(r: tuple[float, float, float, float]) -> float | None:
        v = R.mean(r)
        return None if v is None else v * gain_at((r[0] + r[2]) / 2)

    def cell(xr: float) -> dict[str, tuple[float | None, float | None]] | None:
        xc = xr - W / 2
        rects = _seg_rects(xr, ctx.top_at(xc), ctx.bottom_at(xc), W, t)
        g = gain_at(xc)
        out = {}
        for k, r in rects.items():
            v = R.mean(r)
            out[k] = (None if v is None else v * g, B.mean(r))
        return None if any(v[0] is None for v in out.values()) else out

    cells = [cell(r) for r in rights]
    if any(c is None for c in cells):
        return _reject("no_digits", pol)
    lo, hi = _split([v[0] for c in cells for v in c.values()])
    contrast = hi - lo
    if contrast < MIN_CONTRAST:
        return _reject("low_contrast", pol, contrast=round(contrast, 3))
    thr, half = (lo + hi) / 2, (hi - lo) / 2

    def margin(v: float) -> float:
        return (v - thr) / half

    chars, min_m = [], 9.0
    for c in cells:
        lit = set()
        for k in SEGS:
            m = margin(c[k][0])
            fill = c[k][1]
            if m > 0:
                lit.add(k)
                if fill < 0.25:
                    return _reject("ambiguous_segment", pol)
            elif fill > 0.6:
                return _reject("ambiguous_segment", pol)
            min_m = min(min_m, abs(m))
        for k in "ul":  # hole centres must be empty in every seven-segment digit
            m = margin(c[k][0])
            if m > -MIN_MARGIN:
                return _reject("not_seven_segment", pol)
            min_m = min(min_m, -m)
        fs = frozenset(lit)
        if fs == MINUS:
            return _reject("negative", pol)
        ch = PATTERNS.get(fs)
        if ch is None:
            return _reject("invalid_pattern", pol, segs="".join(sorted(lit)))
        chars.append(ch)
    text_digits = "".join(chars)
    if min_m < MIN_MARGIN:
        weakest = {f"{i}{k}": round(margin(c[k][0]), 2) for i, c in enumerate(cells) for k in SEGS + "ul" if abs(margin(c[k][0])) < MIN_MARGIN}
        return _reject("ambiguous_segment", pol, text=text_digits, margin=round(min_m, 3), weakest=weakest)

    def off_cell(xr: float) -> str | None:
        """None if the cell is clearly empty, else a reject reason (also when it cannot be seen)."""
        c = cell(xr)
        if c is None:
            return "missed_digit"
        ms = {k: margin(c[k][0]) for k in SEGS}
        on = frozenset(k for k, m in ms.items() if m > MIN_MARGIN)
        if on == MINUS and all(ms[k] < -MIN_MARGIN for k in SEGS if k != "g"):
            return "negative"
        # Every digit lights b or c (the right bars); response elsewhere alone is a window edge or a
        # label, not a lost digit.
        if ms["b"] < -MIN_MARGIN and ms["c"] < -MIN_MARGIN:
            return None
        # A window or bezel edge runs on above and below the digits; a digit's bar does not.
        xc = xr - t / 2
        top, bot = ctx.top_at(xc), ctx.bottom_at(xc)
        above = mean((xc - 0.3 * t, top - 0.5 * hh, xc + 0.3 * t, top - 0.2 * hh))
        below = mean((xc - 0.3 * t, bot + 0.2 * hh, xc + 0.3 * t, bot + 0.5 * hh))
        if any(v is not None and margin(v) > -MIN_MARGIN for v in (above, below)):
            return None
        neighbour.update({k: round(m, 2) for k, m in ms.items() if m >= -MIN_MARGIN})
        return "missed_digit"

    neighbour: dict[str, float] = {}
    reason = off_cell(rights[0] - P)
    if reason:
        return _reject(reason, pol, text=text_digits, side="left", neighbour=neighbour)

    # Decimal point: a dot-like blob on the baseline in the gap after a digit; every other gap empty.
    found_dot: int | None = None
    used_dots: set[int] = set()
    n = len(rights)
    for i in range(n):
        gap_l = rights[i]
        gap_r = rights[i + 1] - W if i + 1 < n else rights[i] + (P - W)
        hits = [
            c
            for c in dots
            if gap_l - 0.6 * t <= c.cx <= gap_r + 0.4 * t
            and max(c.w, c.h) <= 1.8 * t
            and ctx.bottom_at(c.cx) - 0.6 * t <= c.y1 <= ctx.bottom_at(c.cx) + 0.8 * t
        ]
        hits = [c for c in hits if (mean((c.x0 + 0.25 * c.w, c.y0 + 0.25 * c.h, c.x1 - 0.25 * c.w, c.y1 - 0.25 * c.h)) or 0.0) > thr + MIN_MARGIN * half]
        if hits:
            if i == n - 1:
                return _reject("ambiguous_dot", pol, text=text_digits)
            if found_dot is not None or len(hits) > 1:
                return _reject("multiple_dots", pol, text=text_digits)
            found_dot = i
            used_dots.update(c.label for c in hits)
            continue
        if i == n - 1:
            continue
        sz = min(1.1 * t, gap_r - gap_l - 0.3 * t)
        if sz < 0.4 * t:
            continue
        xb = ctx.bottom_at((gap_l + gap_r) / 2)
        x, mx = gap_l + 0.15 * t, -9.0
        while x + sz <= gap_r - 0.15 * t + 1e-6:
            v = mean((x, xb - sz, x + sz, xb))
            if v is not None:
                mx = max(mx, v)
            x += max(1.0, sz / 3)
        if mx > -9.0 and margin(mx) > -MIN_MARGIN:
            return _reject("ambiguous_dot", pol, text=text_digits)

    # Unit letters and the cell right of the number (skipped when letters or marks occupy it).
    digit_ids = {lab for g in digits for lab in g.labels}
    loose = [c for c in ctx.comps if c.label not in digit_ids and c.label not in used_dots]
    unit, unit_groups = _unit(ctx, loose, rights[-1], W)
    right_cell = (rights[-1] + P - W, rights[-1] + P)
    busy = any(c.x1 > right_cell[0] and c.x0 < right_cell[1] and c.y1 > ctx.top_at(c.cx) and c.y0 < ctx.bottom_at(c.cx) for c in loose)
    if not busy and off_cell(rights[-1] + P):
        return _reject("missed_digit", pol, text=text_digits, side="right", neighbour=neighbour)

    text = text_digits if found_dot is None else text_digits[: found_dot + 1] + "." + text_digits[found_dot + 1 :]
    decimals = 0 if found_dot is None else n - 1 - found_dot
    int_part = text_digits if found_dot is None else text_digits[: found_dot + 1]
    if len(int_part) > 1 and int_part[0] == "0":
        return _reject("leading_zero", pol, text=text)
    if n > 6:
        return _reject("too_many_digits", pol, text=text)

    assumed = False
    if unit is None:
        # Letters next to the number that are not recognised (lb? g? a label?) forbid assuming kg.
        if unit_groups or not 1 <= decimals <= 3:
            return _reject("unit_unknown", pol, text=text)
        unit, assumed = "kg", True
    if unit == "kg" and not 1 <= decimals <= 3:
        return _reject("no_decimal", pol, text=text)
    if unit == "lb" and not 1 <= decimals <= 2:
        return _reject("no_decimal", pol, text=text)
    if unit == "g" and decimals != 0:
        return _reject("unit_conflict", pol, text=text)
    value = float(text)
    kg = value / 1000.0 if unit == "g" else value * LB_TO_KG if unit == "lb" else value
    if kg <= 0:
        return _reject("zero", pol, text=text)
    if kg > MAX_KG:
        return _reject("out_of_range", pol, text=text)

    # Unexplained blobs inside the number's box lower the confidence.
    x_lo, x_hi = rights[0] - W - 0.2 * W, rights[-1] + 0.2 * W
    stray = sum(
        1
        for c in ctx.comps
        if c.label not in digit_ids
        and c.label not in used_dots
        and c.area >= 0.5 * t * t
        and c.x1 > x_lo
        and c.x0 < x_hi
        and c.y1 > ctx.top_at(c.cx)
        and c.y0 < ctx.bottom_at(c.cx)
        and not any(r - W <= c.cx <= r for r in rights)  # pieces inside a cell are sampled with it
    )
    f_margin = 0.5 + 0.5 * min(1.0, max(0.0, (min_m - MIN_MARGIN) / 0.4))
    f_contrast = 0.5 + 0.5 * min(1.0, max(0.0, (contrast - MIN_CONTRAST) / 0.3))
    f_pitch = 1.0 - 0.6 * min(1.0, max(0.0, pitch_dev - 0.06) / 0.14)
    conf = min(f_margin, f_contrast) * f_pitch * (0.9 if assumed else 1.0) * (0.85**stray)
    return Hyp(
        None,
        text=text,
        unit=unit,
        unit_assumed=assumed,
        weight_kg=round(kg, 4),
        confidence=round(float(conf), 3),
        pol=pol,
        info={"margin": round(min_m, 3), "contrast": round(contrast, 3), "pitchDev": round(pitch_dev, 3), "stray": stray, "strokePx": round(t, 1)},
    )


# --- entry point -----------------------------------------------------------------------------------


def read_scale(bgr: np.ndarray, accept: float = ACCEPT_CONFIDENCE, budget_s: float = TIME_BUDGET_S) -> ScaleReading:
    """Read the weight on a seven-segment scale display; refuses (ok=False) whenever unsure."""
    t0 = time.perf_counter()
    if bgr.ndim == 2:
        bgr = cv2.cvtColor(bgr, cv2.COLOR_GRAY2BGR)
    lum = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    bright = bgr.max(axis=2)  # a red or green LED is much brighter in its own channel than in grey
    H, W = lum.shape
    sw = min(1.0, WORK_SIDE / max(H, W))
    if sw < 1.0:
        size = (max(1, round(W * sw)), max(1, round(H * sw)))
        work_l = cv2.resize(lum, size, interpolation=cv2.INTER_AREA)
        work_b = cv2.resize(bright, size, interpolation=cv2.INTER_AREA)
    else:
        work_l, work_b = lum, bright
    rows = [r.scaled(1.0 / sw) for r in _find_rows(work_l, work_b)][:MAX_ROWS]

    hyps: list[Hyp] = []
    timed_out = False
    for row in rows:
        if time.perf_counter() - t0 > budget_s:
            timed_out = True
            break
        crop = _crop_row(lum if row.pol == "dark" else bright, row)
        hyp = _decode(crop, row.pol) if crop is not None else _reject("no_digits", row.pol)
        hyp.info["digitHeightPx"] = round(row.h, 1)
        hyps.append(hyp)
    elapsed = (time.perf_counter() - t0) * 1000
    summary = [{"pol": h.pol, "reason": h.reason, "text": h.text or h.info.get("text", ""), "confidence": h.confidence, **h.info} for h in hyps]

    good = [h for h in hyps if h.reason is None]
    if not good:
        reason = "timeout" if timed_out else next((h.reason for h in hyps if h.reason != "no_digits"), "no_digits")
        return ScaleReading(False, None, None, False, "", 0.0, reason, None, elapsed, summary)
    best = max(good, key=lambda h: h.confidence)
    rivals = {h.weight_kg for h in good if h.confidence >= 0.35 and h.weight_kg != best.weight_kg}
    if rivals:
        return ScaleReading(False, None, best.unit, best.unit_assumed, best.text, best.confidence, "multiple_numbers", best.weight_kg, elapsed, summary)
    ok = best.confidence >= accept
    return ScaleReading(
        ok,
        best.weight_kg if ok else None,
        best.unit,
        best.unit_assumed,
        best.text,
        best.confidence,
        None if ok else "low_confidence",
        best.weight_kg,
        elapsed,
        summary,
    )
