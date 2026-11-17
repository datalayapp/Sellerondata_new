"""Synthetic scale photos for the free scale reader (app/scale.py): tests and the accuracy tool.

A seven-segment display (LCD: dark digits on a light window, LED: bright digits on a dark window)
is drawn flat, framed by a bezel and a scale body with printed text and buttons, put on a cluttered
background, then warped (rotation, perspective) and degraded (glare, blur, noise, JPEG).

The same pipeline renders displays the reader must refuse: 5x7 dot-matrix digits, an analog dial
and a colour graphic screen. Nothing here is used at request time.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

SEGMENTS = {
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
    "-": "g",
    " ": "",
}
# Common alternative glyphs: 6 without the top bar, 7 with the upper-left bar, 9 without the bottom bar.
VARIANTS = {"6": "cdefg", "7": "abcf", "9": "abcfg"}

DOT_MATRIX = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}

LCD_BACKS = [(178, 196, 182), (200, 205, 198), (170, 190, 200), (150, 200, 170), (205, 215, 215)]
LED_COLOURS = [(50, 40, 235), (70, 235, 80), (235, 200, 60), (60, 150, 250)]
LABELS = ["ZERO", "TARE", "NET", "STABLE", "GROSS", "HOLD", "PCS"]
BODY_TEXT = ["Max 30kg  d=5g", "Max 150kg e=d=50g", "Min 40g", "Max 60 kg  d=10 g", "220V 50Hz", "ON/OFF   TARE   UNIT"]


@dataclass
class DisplayStyle:
    kind: str = "lcd"  # "lcd" | "led"
    digit_h: int = 90
    n_cells: int = 5
    shear: float = 0.10  # italic slant: x shift per unit of height, top to the right
    thickness: float = 0.13  # segment thickness / digit height
    gap: float = 0.025  # gap between segments / digit height
    width: float = 0.55  # digit width / digit height
    pitch: float = 1.38  # cell pitch / digit width
    ghost: float = 0.0  # LCD: off segments faintly visible (0..1 of the on contrast)
    contrast: float = 1.0  # 1 = full contrast between on segments and background
    unit: str | None = "kg"
    labels: bool = True
    dot_style: str = "square"  # "square" | "round"


@dataclass
class PhotoStyle:
    size: tuple[int, int] = (1280, 960)
    display_frac: float = 0.5  # display window width / image width
    rotation: float = 0.0  # degrees
    perspective: float = 0.0  # corner jitter, fraction of the image size
    blur: float = 0.0  # gaussian sigma in px
    motion: int = 0  # motion blur length in px
    noise: float = 0.0  # gaussian noise sigma (0..255)
    glare: float = 0.0  # additive glare blob peak (0..1 of 255)
    jpeg: int = 90
    body_text: bool = True


@dataclass
class ScaleScene:
    image: np.ndarray  # BGR
    text: str  # what the display shows, e.g. "12.34" (no leading blanks); "" if nothing numeric
    unit: str | None
    weight_kg: float | None  # ground truth, None when the scene shows no weight
    display_quad: np.ndarray  # 4x2 display window corners in the image (TL, TR, BR, BL)
    meta: dict = field(default_factory=dict)


def weight_kg(text: str, unit: str | None) -> float | None:
    try:
        v = float(text)
    except ValueError:
        return None
    if unit == "g":
        return v / 1000.0
    if unit == "lb":
        return v * 0.45359237
    return v


def _segment_polys(x0: float, y0: float, w: float, h: float, t: float, gap: float, shear: float) -> dict[str, np.ndarray]:
    L, R = x0 + t / 2, x0 + w - t / 2
    T, M, B = y0 + t / 2, y0 + h / 2, y0 + h - t / 2
    ends = {
        "a": ((L, T), (R, T)),
        "b": ((R, T), (R, M)),
        "c": ((R, M), (R, B)),
        "d": ((L, B), (R, B)),
        "e": ((L, M), (L, B)),
        "f": ((L, T), (L, M)),
        "g": ((L, M), (R, M)),
    }
    out = {}
    for k, (p, q) in ends.items():
        p, q = np.array(p, float), np.array(q, float)
        d = (q - p) / np.linalg.norm(q - p)
        n = np.array([-d[1], d[0]])
        p, q, hw = p + d * gap, q - d * gap, t / 2
        pts = np.array([p, p + d * hw + n * hw, q - d * hw + n * hw, q, q - d * hw - n * hw, p + d * hw - n * hw])
        pts[:, 0] += shear * (y0 + h - pts[:, 1])
        out[k] = pts
    return out


def _fill(img: np.ndarray, pts: np.ndarray, colour) -> None:
    cv2.fillPoly(img, [np.round(pts * 16).astype(np.int32)], colour, lineType=cv2.LINE_AA, shift=4)


def _parse(text: str) -> list[tuple[str, bool]]:
    """'12.34' -> [('1', False), ('2', True), ('3', False), ('4', False)] (char, dot after it)."""
    cells: list[tuple[str, bool]] = []
    for ch in text:
        if ch in ".,":
            if cells:
                cells[-1] = (cells[-1][0], True)
        else:
            cells.append((ch, False))
    return cells


def _mix(a, b, k: float):
    return tuple(int(round(float(x) + k * (float(y) - float(x)))) for x, y in zip(a, b))


def _put_text_fit(img, text, x, y_base, height, colour, thickness, font=cv2.FONT_HERSHEY_SIMPLEX) -> int:
    (_, th), _ = cv2.getTextSize(text, font, 1.0, 1)
    scale = height / max(th, 1)
    cv2.putText(img, text, (int(x), int(y_base)), font, scale, colour, max(1, int(round(thickness))), cv2.LINE_AA)
    (tw, _), _ = cv2.getTextSize(text, font, scale, max(1, int(round(thickness))))
    return tw


def render_display(text: str, style: DisplayStyle, rng: np.random.Generator, glyphs: str = "segments") -> np.ndarray:
    """Flat display window (BGR). glyphs: 'segments' (seven-segment) or 'dots' (5x7 dot matrix)."""
    h = style.digit_h
    w = style.width * h
    t = style.thickness * h
    pitch = style.pitch * w
    cells = _parse(text)
    n = max(style.n_cells, len(cells))
    cells = [(" ", False)] * (n - len(cells)) + cells
    unit_w = 1.6 * h if style.unit else 0.3 * h
    W = int(0.45 * h + n * pitch + unit_w + 0.3 * h)
    H = int(h * 1.9)
    y0 = (H - h) / 2 + rng.uniform(-0.05, 0.05) * h

    if style.kind == "lcd":
        back = LCD_BACKS[rng.integers(len(LCD_BACKS))]
        on = (int(rng.integers(25, 60)),) * 3
    else:
        back = (int(rng.integers(12, 40)),) * 3
        on = LED_COLOURS[rng.integers(len(LED_COLOURS))]
    on = _mix(back, on, style.contrast)
    img = np.empty((H, W, 3), np.uint8)
    img[:] = back
    layer = np.zeros_like(img)  # LED light, blurred into a glow afterwards
    ghost_col = _mix(back, on, style.ghost)

    x = 0.45 * h
    for ch, dot in cells:
        polys = _segment_polys(x, y0, w, h, t, style.gap * h, style.shear)
        if glyphs == "segments":
            lit = SEGMENTS.get(ch, "")
            for k, p in polys.items():
                if k in lit:
                    _fill(img, p, on)
                    _fill(layer, p, on)
                elif style.ghost > 0:
                    _fill(img, p, ghost_col)
        elif ch in DOT_MATRIX:
            r = min(w / 5, h / 7) * 0.36
            for j, row in enumerate(DOT_MATRIX[ch]):
                for i, bit in enumerate(row):
                    cx = x + (i + 0.5) * w / 5 + style.shear * (h - (j + 0.5) * h / 7)
                    cy = y0 + (j + 0.5) * h / 7
                    if bit == "1":
                        cv2.circle(img, (int(cx * 16), int(cy * 16)), int(r * 16), on, -1, cv2.LINE_AA, 4)
                        cv2.circle(layer, (int(cx * 16), int(cy * 16)), int(r * 16), on, -1, cv2.LINE_AA, 4)
        # Decimal point in the gap after the digit, on the baseline.
        ds = min(1.0 * t, 0.6 * (pitch - w))
        dcx = x + w + (pitch - w) / 2
        dcy = y0 + h - ds / 2
        dot_col = on if dot else (ghost_col if style.ghost > 0 else None)
        if dot_col is not None:
            if style.dot_style == "round":
                cv2.circle(img, (int(dcx * 16), int(dcy * 16)), int(ds / 2 * 16), dot_col, -1, cv2.LINE_AA, 4)
            else:
                _fill(img, np.array([[dcx - ds / 2, dcy - ds / 2], [dcx + ds / 2, dcy - ds / 2], [dcx + ds / 2, dcy + ds / 2], [dcx - ds / 2, dcy + ds / 2]]), dot_col)
            if dot:
                cv2.circle(layer, (int(dcx * 16), int(dcy * 16)), int(ds / 2 * 16), on, -1, cv2.LINE_AA, 4)
        x += pitch

    if style.unit:
        ux = x - pitch + w + 0.35 * w
        _put_text_fit(img, style.unit, ux, y0 + h * 0.97, 0.5 * h, on, max(1.0, 0.075 * h))
    if style.labels:
        small = 0.13 * h
        lab_col = _mix(back, on, 0.8 * style.contrast if style.kind == "lcd" else 0.6)
        lx = 0.5 * h
        for name in rng.choice(LABELS, size=int(rng.integers(1, 4)), replace=False):
            top = rng.random() < 0.5
            yb = y0 - 0.22 * h if top else y0 + h + 0.22 * h + small
            if yb - small < 2 or yb > H - 2:
                continue
            lx += _put_text_fit(img, str(name), lx, yb, small, lab_col, max(1.0, 0.02 * h)) + 0.5 * h
            if lx > W - h:
                break
    if style.kind == "led":
        glow = cv2.GaussianBlur(layer.astype(np.float32), (0, 0), 0.06 * h)
        out = cv2.GaussianBlur(img.astype(np.float32) + 0.5 * glow, (0, 0), 0.012 * h + 0.3)
        return np.clip(out, 0, 255).astype(np.uint8)
    return img


def _background(size: tuple[int, int], rng: np.random.Generator) -> np.ndarray:
    W, H = size
    base = np.array(rng.uniform(60, 200, 3))
    gx = np.linspace(-1, 1, W)[None, :, None] * rng.uniform(-40, 40)
    gy = np.linspace(-1, 1, H)[:, None, None] * rng.uniform(-40, 40)
    img = np.clip(base[None, None, :] + gx + gy, 0, 255)
    tex = cv2.GaussianBlur(rng.normal(0, 25, (H, W)).astype(np.float32), (0, 0), 3)
    img = np.clip(img + tex[..., None], 0, 255).astype(np.uint8)
    for _ in range(int(rng.integers(3, 9))):  # clutter: boxes, tape, cables
        c = tuple(int(v) for v in rng.integers(0, 255, 3))
        if rng.random() < 0.5:
            p = rng.integers(0, [W, H])
            q = p + rng.integers(40, 400, 2)
            cv2.rectangle(img, tuple(int(v) for v in p), tuple(int(v) for v in q), c, -1)
        else:
            p, q = rng.integers(0, [W, H], (2, 2))
            cv2.line(img, tuple(int(v) for v in p), tuple(int(v) for v in q), c, int(rng.integers(2, 12)), cv2.LINE_AA)
    return img


def _compose(display: np.ndarray, photo: PhotoStyle, rng: np.random.Generator, kind: str) -> tuple[np.ndarray, np.ndarray]:
    """Bezel + scale body around the display, on a background, warped and degraded."""
    W, H = photo.size
    img = _background(photo.size, rng)
    dh, dw = display.shape[:2]
    s = photo.display_frac * W / dw
    disp = cv2.resize(display, (max(2, int(dw * s)), max(2, int(dh * s))), interpolation=cv2.INTER_AREA)
    dh, dw = disp.shape[:2]
    bez = int(0.12 * dh)
    body_w, body_h = int(dw * 1.45), int(dh * 3.0)
    bx = int(W / 2 - body_w / 2 + rng.uniform(-0.08, 0.08) * W)
    by = int(H / 2 - body_h * 0.35 + rng.uniform(-0.06, 0.06) * H)
    body_col = [(235, 235, 230), (120, 120, 125), (40, 40, 45), (150, 110, 60)][rng.integers(4)]
    cv2.rectangle(img, (bx, by), (bx + body_w, by + body_h), body_col, -1)
    dx, dy = bx + (body_w - dw) // 2, by + int(0.25 * dh)
    bezel = (30, 30, 32) if kind == "led" or rng.random() < 0.6 else (90, 90, 95)
    cv2.rectangle(img, (dx - bez, dy - bez), (dx + dw + bez, dy + dh + bez), bezel, -1)
    y_end, x_end = min(H, dy + dh), min(W, dx + dw)
    if dy >= 0 and dx >= 0 and y_end > dy and x_end > dx:
        img[dy:y_end, dx:x_end] = disp[: y_end - dy, : x_end - dx]
    ink = (20, 20, 20) if sum(body_col) > 400 else (230, 230, 230)
    if photo.body_text:
        _put_text_fit(img, str(rng.choice(BODY_TEXT)), dx, dy + dh + bez + 0.35 * dh, 0.16 * dh, ink, max(1.0, 0.025 * dh))
    for i in range(4):  # buttons
        cx = int(dx + (i + 0.5) * dw / 4)
        cv2.circle(img, (cx, int(dy + dh + bez + 0.8 * dh)), int(0.14 * dh), (60, 60, 200) if i == 0 else (90, 90, 90), -1, cv2.LINE_AA)
    quad = np.array([[dx, dy], [dx + dw, dy], [dx + dw, dy + dh], [dx, dy + dh]], np.float64)

    # Geometry: rotation about the image centre plus independent corner jitter (perspective).
    src = np.array([[0, 0], [W, 0], [W, H], [0, H]], np.float32)
    ang = np.deg2rad(photo.rotation)
    c, sn = np.cos(ang), np.sin(ang)
    centre = np.array([W / 2, H / 2])
    dst = (src - centre) @ np.array([[c, sn], [-sn, c]]) + centre
    dst = dst + rng.uniform(-1, 1, (4, 2)) * photo.perspective * np.array([W, H])
    Hm = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
    img = cv2.warpPerspective(img, Hm, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    quad = cv2.perspectiveTransform(quad[None].astype(np.float32), Hm)[0].astype(np.float64)

    out = img.astype(np.float32)
    if photo.glare > 0:
        q = quad.mean(axis=0) + rng.uniform(-0.3, 0.3, 2) * (quad[1] - quad[0])[0]
        yy, xx = np.mgrid[0:H, 0:W]
        sig = 0.25 * np.linalg.norm(quad[1] - quad[0])
        blob = np.exp(-(((xx - q[0]) ** 2) / (2 * sig**2) + ((yy - q[1]) ** 2) / (2 * (0.6 * sig) ** 2)))
        out += (photo.glare * 255.0 * blob)[..., None].astype(np.float32)
    if photo.blur > 0:
        out = cv2.GaussianBlur(out, (0, 0), photo.blur)
    if photo.motion > 1:
        k = np.zeros((photo.motion, photo.motion), np.float32)
        k[photo.motion // 2, :] = 1.0 / photo.motion
        out = cv2.filter2D(out, -1, k)
    if photo.noise > 0:
        out += rng.normal(0, photo.noise, out.shape).astype(np.float32)
    out = np.clip(out, 0, 255).astype(np.uint8)
    if photo.jpeg < 100:
        out = cv2.imdecode(cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, photo.jpeg])[1], cv2.IMREAD_COLOR)
    return out, quad


def random_weight(rng: np.random.Generator) -> tuple[str, str | None]:
    """A plausible display text and unit: mostly kg with 1-3 decimals, sometimes grams or pounds."""
    r = rng.random()
    if r < 0.12:
        return str(int(rng.integers(5, 30000))), "g"
    if r < 0.2:
        return f"{rng.uniform(0.2, 300):.1f}", "lb"
    decimals = int(rng.choice([1, 2, 3], p=[0.2, 0.45, 0.35]))
    top = float(rng.choice([2.0, 10.0, 60.0, 150.0, 299.0], p=[0.25, 0.3, 0.25, 0.15, 0.05]))
    v = rng.uniform(0.01, top)
    text = f"{v:.{decimals}f}"
    if float(text) == 0.0:
        text = f"{0.5:.{decimals}f}"
    return text, "kg"


def random_display_style(rng: np.random.Generator, text: str, unit: str | None, **over) -> DisplayStyle:
    digits = sum(ch.isdigit() for ch in text)
    s = DisplayStyle(
        kind="lcd" if rng.random() < 0.6 else "led",
        digit_h=int(rng.integers(70, 120)),
        n_cells=int(digits + rng.integers(0, 2)),
        shear=float(rng.choice([0.0, rng.uniform(0.05, 0.2)])),
        thickness=float(rng.uniform(0.10, 0.17)),
        gap=float(rng.uniform(0.012, 0.035)),
        width=float(rng.uniform(0.5, 0.62)),
        pitch=float(rng.uniform(1.3, 1.5)),
        # A display without any unit legend is assumed to be kg (the reader does the same).
        unit=unit if unit != "kg" or rng.random() < 0.85 else None,
        dot_style="round" if rng.random() < 0.4 else "square",
    )
    if s.kind == "lcd" and rng.random() < 0.4:
        s.ghost = float(rng.uniform(0.03, 0.09))
    for k, v in over.items():
        setattr(s, k, v)
    return s


def render_scale(
    text: str,
    unit: str | None = "kg",
    display: DisplayStyle | None = None,
    photo: PhotoStyle | None = None,
    seed: int = 0,
    glyphs: str = "segments",
) -> ScaleScene:
    rng = np.random.default_rng(seed)
    display = display or DisplayStyle(unit=unit)
    photo = photo or PhotoStyle()
    disp = render_display(text, display, rng, glyphs)
    img, quad = _compose(disp, photo, rng, display.kind)
    truth = weight_kg(text, display.unit if display.unit else unit) if glyphs == "segments" else None
    return ScaleScene(img, text, display.unit, truth, quad, {"display": display, "photo": photo, "glyphs": glyphs, "true_unit": unit})


def render_analog(seed: int = 0, photo: PhotoStyle | None = None) -> ScaleScene:
    """Analog dial scale (needle over a printed scale with numbers): no seven-segment display."""
    rng = np.random.default_rng(seed)
    S = 400
    dial = np.full((S, int(S * 1.4), 3), 240, np.uint8)
    c = (dial.shape[1] // 2, S // 2)
    cv2.circle(dial, c, int(S * 0.45), (30, 30, 30), 3, cv2.LINE_AA)
    for i in range(0, 41):
        a = np.deg2rad(-220 + i * 260 / 40)
        r0 = S * (0.36 if i % 5 else 0.32)
        p = (int(c[0] + r0 * np.cos(a)), int(c[1] + r0 * np.sin(a)))
        q = (int(c[0] + S * 0.42 * np.cos(a)), int(c[1] + S * 0.42 * np.sin(a)))
        cv2.line(dial, p, q, (20, 20, 20), 2, cv2.LINE_AA)
        if i % 5 == 0:
            tp = (int(c[0] + S * 0.25 * np.cos(a)) - 12, int(c[1] + S * 0.25 * np.sin(a)) + 8)
            cv2.putText(dial, str(i // 5 * 5), tp, cv2.FONT_HERSHEY_SIMPLEX, 0.8, (20, 20, 20), 2, cv2.LINE_AA)
    a = np.deg2rad(-220 + rng.uniform(0, 260))
    cv2.line(dial, c, (int(c[0] + S * 0.4 * np.cos(a)), int(c[1] + S * 0.4 * np.sin(a))), (30, 30, 200), 4, cv2.LINE_AA)
    cv2.putText(dial, "kg", (c[0] - 20, c[1] + 90), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (20, 20, 20), 2, cv2.LINE_AA)
    img, quad = _compose(dial, photo or PhotoStyle(), rng, "lcd")
    return ScaleScene(img, "", None, None, quad, {"glyphs": "analog"})


def render_graphic(seed: int = 0, photo: PhotoStyle | None = None, text: str = "12.34 kg") -> ScaleScene:
    """Colour TFT screen: bar graph, icons and the weight in an ordinary (non-segment) font."""
    rng = np.random.default_rng(seed)
    H, W = 300, 640
    scr = np.zeros((H, W, 3), np.uint8)
    scr[:] = (90, 40, 20)
    for i in range(12):
        bh = int(rng.uniform(20, 120))
        cv2.rectangle(scr, (30 + i * 48, H - 20 - bh), (60 + i * 48, H - 20), tuple(int(v) for v in rng.integers(80, 255, 3)), -1)
    cv2.putText(scr, text, (40, 110), cv2.FONT_HERSHEY_DUPLEX, 2.6, (255, 255, 255), 5, cv2.LINE_AA)
    cv2.circle(scr, (W - 50, 40), 18, (0, 200, 255), -1)
    img, quad = _compose(scr, photo or PhotoStyle(), rng, "led")
    return ScaleScene(img, "", None, None, quad, {"glyphs": "graphic"})


def render_empty(seed: int = 0, photo: PhotoStyle | None = None) -> ScaleScene:
    """A photo with no scale at all (background clutter only)."""
    rng = np.random.default_rng(seed)
    photo = photo or PhotoStyle()
    img = _background(photo.size, rng)
    return ScaleScene(img, "", None, None, np.zeros((4, 2)), {"glyphs": "none"})


# --- benchmark conditions (tests and tools/scale_accuracy.py) ---------------------------------------


def _pm(rng: np.random.Generator, a: float) -> float:
    return float(rng.uniform(-a, a))


# name -> rng -> (display style overrides, photo style)
CONDITIONS = {
    "temiz": lambda rng: ({}, PhotoStyle()),
    "eğik (±10°)": lambda rng: ({}, PhotoStyle(rotation=_pm(rng, 10))),
    "perspektif": lambda rng: ({}, PhotoStyle(rotation=_pm(rng, 3), perspective=0.04)),
    "bulanık (σ=1.5)": lambda rng: ({}, PhotoStyle(blur=1.5)),
    "bulanık (σ=3)": lambda rng: ({}, PhotoStyle(blur=3.0)),
    "titreme (9 px)": lambda rng: ({}, PhotoStyle(motion=9)),
    "gürültü (σ=12)": lambda rng: ({}, PhotoStyle(noise=12, jpeg=80)),
    "parlama": lambda rng: ({}, PhotoStyle(glare=0.55)),
    "düşük kontrast": lambda rng: ({"contrast": 0.35}, PhotoStyle()),
    "küçük ekran": lambda rng: ({}, PhotoStyle(display_frac=0.2)),
    "karışık orta": lambda rng: (
        {"contrast": 0.6},
        PhotoStyle(rotation=_pm(rng, 6), perspective=0.02, blur=1.2, noise=6, glare=0.25, jpeg=75),
    ),
    "karışık ağır": lambda rng: (
        {"contrast": 0.35},
        PhotoStyle(rotation=_pm(rng, 10), perspective=0.04, blur=2.5, noise=15, glare=0.6, jpeg=60),
    ),
}


def make_case(condition: str, seed: int) -> ScaleScene:
    """One random weight on one random display under the named condition (deterministic per seed)."""
    rng = np.random.default_rng(seed)
    text, unit = random_weight(rng)
    over, photo = CONDITIONS[condition](rng)
    style = random_display_style(rng, text, unit, **over)
    return render_scale(text, unit, style, photo, seed=seed)


def _no_weight(scene: ScaleScene) -> ScaleScene:
    scene.weight_kg = None
    return scene


# Scenes that must never yield a weight. name -> seed -> scene (weight_kg None).
NEGATIVES = {
    "nokta matris": lambda seed: _no_weight(render_scale(*random_weight(np.random.default_rng(seed)), seed=seed, glyphs="dots")),
    "ibreli terazi": lambda seed: render_analog(seed),
    "renkli ekran": lambda seed: render_graphic(seed, text=f"{np.random.default_rng(seed).uniform(0.1, 60):.2f} kg"),
    "tartı yok": lambda seed: render_empty(seed),
    "sıfır (0.000)": lambda seed: _no_weight(render_scale("0.000", "kg", seed=seed)),
    "eksi (-1.25)": lambda seed: _no_weight(render_scale("-1.25", "kg", seed=seed)),
}
