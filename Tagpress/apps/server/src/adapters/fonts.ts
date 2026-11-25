import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FontEntry, Profile } from "@tagpress/domain";
import { FontRegistry, segmentGraphemes, shapeRun, runToSvg, svgDocument } from "@tagpress/typeset";
import sharp from "sharp";
import type { CoverageResult, FontCatalog, FontCoverage } from "../ports.ts";
import { maybeOrg } from "../org/context.ts";
import { basicFontCoverage } from "../wiring.ts";

/**
 * typeset paketine bağlantı: dil başına `FontRegistry` önbelleği, glif kapsamı ve font kataloğu.
 *
 * Önbellek anahtarı = dilin font klasörü + ortak font klasörü + profilin font listesi + iki klasördeki dosyaların
 * (ad, boyut, değişme zamanı) imzası. Font yüklenince ya da profilin font listesi değişince anahtar değişir ve
 * kayıt yeniden kurulur; elle geçersiz kılmaya gerek kalmaz (`invalidate` yine de vardır).
 */

const FONT_FILE = /\.(ttf|otf|ttc)$/i;
const CACHE_MAX = 8;

function dirSignature(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => FONT_FILE.test(f))
    .sort()
    .map((f) => {
      const st = statSync(path.join(dir, f));
      return `${f}:${st.size}:${Math.round(st.mtimeMs)}`;
    })
    .join("|");
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

export class FontRegistryCache {
  /**
   * Profil kayıtları. Süreç genelidir; her kayıt kuran firmanın kimliğiyle saklanır ve `findWith`/`resolveFace` yalnız
   * geçerli firmanın kayıtlarını tarar (başka firmanın font listesi ve dosyaları görünmez). `forProfile` anahtarında
   * firma da vardır: aynı klasör iki firmada farklı kayıt sayılır.
   */
  private readonly cache = new Map<string, { reg: FontRegistry; org: string | null }>();
  /** Katalog (bütün font klasörleri, profil eşlemesiz): `resolveFace` için. */
  private catalog: { sig: string; reg: FontRegistry } | null = null;

  constructor(
    private readonly sharedFontsDir: string,
    /** Bütün dillerin font klasörleri (katalog için). */
    private readonly allFontDirs: () => string[] = () => [],
    private readonly systemFallbacks?: boolean,
  ) {}

  /** Profilin fontlarıyla kayıt (dil klasörü + ortak yedekler). */
  forProfile(fontsDir: string, profile: Pick<Profile, "fonts" | "glyphRules">, sharedFontsDir = this.sharedFontsDir): FontRegistry {
    const entries: FontEntry[] = profile.fonts.list;
    const org = maybeOrg()?.orgId ?? null;
    const key = JSON.stringify([org, fontsDir, sharedFontsDir, entries, dirSignature(fontsDir), dirSignature(sharedFontsDir)]);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.reg;
    }
    const reg = FontRegistry.createSync({
      entries,
      fontDir: fontsDir,
      fallbackDirs: [sharedFontsDir],
      ...(this.systemFallbacks !== undefined ? { systemFallbacks: this.systemFallbacks } : {}),
    });
    this.cache.set(key, { reg, org });
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return reg;
  }

  /** Bütün kayıtları bırakır (sonraki istekte yeniden kurulur). */
  invalidate(): void {
    this.cache.clear();
    this.catalog = null;
  }

  /** Kullanılan kayıtlar arasında bu font kimliklerinin hepsini bilen ilki (en yenisi başta). */
  findWith(fontIds: readonly string[]): FontRegistry | null {
    for (const reg of this.mine()) if (fontIds.every((id) => reg.has(id))) return reg;
    return null;
  }

  /** Geçerli firmanın (bağlamsızsa yalnız bağlamsız kurulmuş) kayıtları, en yenisi başta. */
  private mine(): FontRegistry[] {
    const org = maybeOrg()?.orgId ?? null;
    return [...this.cache.values()]
      .filter((e) => e.org === org)
      .map((e) => e.reg)
      .reverse();
  }

  /** Aile/stil adından yüz kimliği (önce profil eşlemeli kayıtlar, sonra bütün klasörlerin kataloğu). */
  resolveFace(family: string, style: string): { reg: FontRegistry; id: string } | null {
    const want = `${family}/${style}`;
    for (const reg of this.mine()) if (reg.has(want)) return { reg, id: want };
    const cat = this.catalogRegistry();
    if (cat.has(want)) return { reg: cat, id: want };
    const faces = cat.list();
    const hit =
      faces.find((f) => norm(f.family) === norm(family) && norm(f.style) === norm(style || "Regular")) ??
      faces.find((f) => norm(f.family) === norm(family) && norm(f.style) === "regular") ??
      faces.find((f) => norm(f.family) === norm(family));
    return hit ? { reg: cat, id: hit.id } : null;
  }

  private catalogRegistry(): FontRegistry {
    const dirs = [...new Set([...this.allFontDirs(), this.sharedFontsDir])];
    // Katalog geçerli firmanın klasörlerinden (`allFontDirs` firma köküne göre) + ortak; imzada firma da var.
    const sig = JSON.stringify([maybeOrg()?.orgId ?? null, dirs.map((d) => [d, dirSignature(d)])]);
    if (this.catalog?.sig === sig) return this.catalog.reg;
    const reg = FontRegistry.createSync({ systemFallbacks: false });
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => FONT_FILE.test(x)).sort()) {
        try {
          reg.addFile(path.join(dir, f), null);
        } catch {
          // Bozuk dosya katalogda atlanır (font listesi uyarıyı ayrıca gösterir).
        }
      }
    }
    this.catalog = { sig, reg };
    return reg;
  }
}

/**
 * Glif kapsamı: karakteri profilin metin fontlarından (rolü olan, açık) en az biri basabiliyorsa sorun yok;
 * basamıyor ama yedek font basıyorsa `fallback`; hiçbir font (yedekler ve sistem yedekleri dahil) basamıyorsa
 * `missing` (içe aktarmada hata). Profilin hiçbir fontu yüklenemiyorsa glif bilinmez: sade tahmine düşülür.
 */
export function createFontCoverage(cache: FontRegistryCache): FontCoverage {
  return {
    check(text, ctx): CoverageResult {
      let reg: FontRegistry;
      try {
        reg = cache.forProfile(ctx.fontsDir, ctx.profile, ctx.sharedFontsDir);
      } catch {
        return basicFontCoverage.check(text, ctx);
      }
      const design = ctx.profile.fonts.list.filter((f) => f.enabled && f.roles.length && reg.has(f.id)).map((f) => f.id);
      if (!design.length) return basicFontCoverage.check(text, ctx);
      const fallback = new Set<string>();
      const missing = new Set<string>();
      const partial = new Set<string>();
      const monochrome = new Set<string>();
      for (const g of segmentGraphemes(text)) {
        if (/^\s+$/u.test(g) || /^\p{Cc}+$/u.test(g)) continue;
        // Motorla aynı küme kararı (typeset `resolve`): tasarım fontlarından biri basıyorsa sorun yok.
        const res = design.map((id) => reg.resolve(g, id));
        if (res.some((r) => r && !r.fallback)) continue;
        const r = res.find((x) => x !== null);
        if (!r) {
          missing.add(g);
          continue;
        }
        fallback.add(g);
        if (r.partial) partial.add(g);
        if (r.monochrome) monochrome.add(g);
      }
      return { fallback: [...fallback], missing: [...missing], ...(partial.size ? { partial: [...partial] } : {}), ...(monochrome.size ? { monochrome: [...monochrome] } : {}) };
    },
  };
}

function pickFace(faces: ReturnType<FontRegistry["addFile"]>) {
  return faces.find((f) => /^regular$/i.test(f.style)) ?? faces[0] ?? null;
}

/** Font kataloğu: dosya adı çözümü ve örnek görsel. */
export function createFontCatalog(): FontCatalog {
  return {
    async describe(file) {
      try {
        const face = pickFace(FontRegistry.createSync({ systemFallbacks: false }).addFile(file, null));
        return face ? { family: face.family, style: face.style } : null;
      } catch {
        return null;
      }
    },
    async specimen(file, text, sizePx) {
      const reg = FontRegistry.createSync({ systemFallbacks: false });
      const face = pickFace(reg.addFile(file, null));
      if (!face) throw new Error("Font okunamadı.");
      const run = shapeRun(reg, text, { fontId: face.id, sizePx });
      const pad = Math.round(sizePx * 0.4);
      const ink = run.ink ?? { x0: 0, y0: -sizePx, x1: run.advance, y1: sizePx * 0.3 };
      const x0 = Math.min(0, ink.x0);
      const w = Math.ceil(Math.max(run.advance, ink.x1) - x0 + 2 * pad);
      const h = Math.ceil(ink.y1 - ink.y0 + 2 * pad);
      const body = runToSvg(reg, run, pad - x0, pad - ink.y0, { color: "#1a1a1a" });
      return sharp(Buffer.from(svgDocument(Math.max(1, w), Math.max(1, h), body, "#ffffff"))).png().toBuffer();
    },
  };
}
