import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Belirteç kayması ve karşıtlık: tokens.css'teki platform kopyası Platform/packages/tokens/tokens.json ile aynı mı,
 * TagPress bandı kabuğun bandTheme formülüyle aynı mı, ana metin/zemin çiftleri en az 4.5:1 mi.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("./tokens.css");
const generated = read("./tokens.generated.css");
const doc = JSON.parse(read("../../../../../Platform/packages/tokens/tokens.json")) as {
  base: Record<string, string>;
  bands: Record<string, Record<string, string>>;
  products: Record<string, Record<string, string>>;
};
const appShell = read("../../../../../Platform/packages/shell/src/AppShell.tsx");

function block(name: string, src = css): Map<string, string> {
  const m = src.match(new RegExp(`/\\* @blok ${name} \\*/([\\s\\S]*?)/\\* @son ${name} \\*/`));
  if (!m?.[1]) throw new Error(`blok yok: ${name}`);
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(d[1]!, d[2]!.trim());
  return out;
}
const base = block("platform:base");
const tagpress = block("tagpress", generated);
const tezgah = block("tezgah", generated);
/** Son geçerli değer (sonraki blok öncekini ezer). */
const value = (k: string) => tezgah.get(k) ?? tagpress.get(k) ?? base.get(k);

/** tokens.json başvurusu: "{--ad}" base değişkeni, "{a.b.c}" dosyada yol. */
function resolve(v: string, depth = 0): string {
  const m = /^\{(.+)\}$/.exec(v);
  if (!m || depth > 5) return v;
  const ref = m[1]!;
  if (ref.startsWith("--")) return resolve(doc.base[ref]!, depth + 1);
  const hit = ref.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], doc);
  return resolve(String(hit), depth + 1);
}
const norm = (v: string) => v.replace(/\s+/g, " ").replace(/"/g, "'").trim().toLowerCase();

// ---- renk yardımcıları
function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
}
const hex = (c: number[]) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
/** CSS color-mix(in srgb, a p%, b): kanal kanal doğrusal karışım. */
const mix = (a: string, p: number, b: string) => hex(rgb(a).map((x, i) => (x * p + rgb(b)[i]! * (100 - p)) / 100));
function luminance(h: string) {
  const [r, g, b] = rgb(h).map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe("tokens.css platform kopyası", () => {
  it("TagPress ve Tezgâh değerleri tek yerde: üretilen tokens.generated.css (tokens.css'te yalnız base)", () => {
    expect(css).not.toMatch(/@blok (tagpress|tezgah)/);
    expect(generated).toMatch(/ÜRETİLDİ/);
  });

  it("base bloğu tokens.json base ile birebir aynı (eksik, fazla, farklı yok)", () => {
    const want = Object.fromEntries(Object.entries(doc.base).map(([k, v]) => [k, norm(resolve(v))]));
    const got = Object.fromEntries([...base].map(([k, v]) => [k, norm(v)]));
    expect(got).toEqual(want);
  });

  it("TagPress rengi products.tagpress'ten", () => {
    const p = doc.products.tagpress!;
    expect(tagpress.get("--primary")).toBe(p.main);
    expect(tagpress.get("--primary-soft")).toBe(p.soft);
    expect(tagpress.get("--primary-text")).toBe(p.text);
    expect(tagpress.get("--focus")).toBe(p.main);
    expect(tagpress.get("--sod-product")).toBe(p.main);
  });

  it("bant renkleri kabuğun bandTheme formülüyle aynı", () => {
    const c = doc.products.tagpress!.main!;
    // Formül kabukta değişirse bu test de güncellenmeli: AppShell.tsx'teki yüzdeleri denetle.
    for (const s of ["82%, #000", "68%, #000", "10%, #fff", "35%, #fff"]) expect(appShell).toContain(`\${c} ${s}`);
    expect(tagpress.get("--sod-band")).toBe(mix(c, 82, "#000000"));
    expect(tagpress.get("--sod-band-2")).toBe(mix(c, 68, "#000000"));
    expect(tagpress.get("--sod-band-on")).toBe(mix(c, 10, "#ffffff"));
    expect(tagpress.get("--sod-band-accent")).toBe(mix(c, 35, "#ffffff"));
    expect(tagpress.get("--sod-band-cta")).toBe("#ffffff");
    expect(tagpress.get("--sod-band-cta-hover")).toBe(mix(c, 10, "#ffffff"));
    expect(tagpress.get("--sod-band-cta-ink")).toBe(mix(c, 82, "#000000"));
  });

  it("platform adı taşıyan TagPress değeri platform bloğunda da var (yeni ad --tz- önekli olur)", () => {
    const own = new Set(["--primary-text"]);
    for (const k of tagpress.keys()) if (!own.has(k)) expect(base.has(k), k).toBe(true);
    for (const k of tezgah.keys()) expect(k.startsWith("--tz-"), k).toBe(true);
  });
});

describe("Tezgâh renkleri", () => {
  it("kesim, kesim işareti, cetvel ve tuval renkleri tanımlı", () => {
    for (const k of ["--tz-cut", "--tz-crop", "--tz-canvas", "--tz-canvas-grid", "--tz-ruler-bg", "--tz-ruler-line", "--tz-ruler-major", "--tz-ruler-minor", "--tz-ruler-hi"]) {
      expect(value(k), k).toBeTruthy();
    }
    expect(value("--tz-cut")).toBe("#e0218a");
  });

  const pairs: Array<[string, string]> = [
    ["--text", "--bg"],
    ["--text", "--surface"],
    ["--text-2", "--surface"],
    ["--text-3", "--surface"],
    ["--text-3", "--surface-2"],
    ["--primary-text", "--surface"],
    ["--primary-text", "--primary-soft"],
    ["--tz-on-band", "--primary"],
    ["--tz-on-band", "--sod-band"],
    ["--sod-band-on", "--sod-band"],
    ["--sod-band-cta-ink", "--sod-band-cta"],
    ["--danger", "--danger-bg"],
    ["--warning", "--warning-bg"],
    ["--success", "--success-bg"],
    ["--tz-info", "--tz-info-bg"],
    ["--tz-artboard-ink", "--tz-canvas"],
    ["--tz-ruler-major", "--tz-ruler-bg"],
    ["--tz-tip-ink", "--tz-tip-bg"],
  ];
  it.each(pairs)("%s / %s en az 4.5:1", (fg, bg) => {
    const a = value(fg);
    const b = value(bg);
    expect(a && /^#[0-9a-f]{6}$/i.test(a), `${fg} = ${a}`).toBe(true);
    expect(b && /^#[0-9a-f]{6}$/i.test(b), `${bg} = ${b}`).toBe(true);
    expect(contrast(a!, b!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("marka işareti", () => {
  it("cerceve/tagpress-mark.svg Platform/brand/tagpress-mark.svg ile aynı", () => {
    expect(read("./cerceve/tagpress-mark.svg").trim()).toBe(read("../../../../../Platform/brand/tagpress-mark.svg").trim());
  });
});
