import type { Shape } from "@tagpress/domain";

/** Nokta şeklin içinde mi? (tasarım px) */
export function insideShape(s: Shape, x: number, y: number): boolean {
  switch (s.kind) {
    case "circle":
      return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
    case "ellipse":
      return ((x - s.cx) / s.rx) ** 2 + ((y - s.cy) / s.ry) ** 2 <= 1;
    case "rect": {
      if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
      const r = Math.min(s.radius, s.w / 2, s.h / 2);
      if (r <= 0) return true;
      const cx = Math.min(Math.max(x, s.x + r), s.x + s.w - r);
      const cy = Math.min(Math.max(y, s.y + r), s.y + s.h - r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    }
    case "polygon": {
      let inside = false;
      const p = s.points;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[i]!, b = p[j]!;
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    }
  }
}

/** Kesim çapı (px): daire/elipste kısa çap, dikdörtgende kısa kenar (domain `cutDiameter` ile aynı kural). */
export function shapeDiameter(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return 2 * s.r;
    case "ellipse":
      return 2 * Math.min(s.rx, s.ry);
    case "rect":
      return Math.min(s.w, s.h);
    case "polygon": {
      const xs = s.points.map((q) => q.x);
      const ys = s.points.map((q) => q.y);
      return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }
  }
}

/** Şekli her yönde `d` kadar içe (d > 0) ya da dışa (d < 0) çeker. Çokgende değişmez. */
export function insetShape(s: Shape, d: number): Shape {
  switch (s.kind) {
    case "circle":
      return { ...s, r: Math.max(0.01, s.r - d) };
    case "ellipse":
      return { ...s, rx: Math.max(0.01, s.rx - d), ry: Math.max(0.01, s.ry - d) };
    case "rect":
      return { ...s, x: s.x + d, y: s.y + d, w: Math.max(0.01, s.w - 2 * d), h: Math.max(0.01, s.h - 2 * d), radius: Math.max(0, s.radius - d) };
    case "polygon":
      return s;
  }
}
