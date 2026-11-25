import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import * as hb from "harfbuzzjs";
import { type FontEntry, type FontKind, graphemes, isEmojiGrapheme } from "@tagpress/domain";
import { SYSTEM_TEXT_FALLBACKS, findSystemFonts, systemFontDirs } from "./system-fonts.ts";

/**
 * Font kaydı: tasarım dilinin font klasörü + ortak yedek font klasörü + uygulamayla gelen yedekler + (varsa) sistem
 * yedekleri.
 *
 * - Profilin `fonts.list` girdileri ("Aile/Stil") dosyalara eşlenir; font türü (script/serif…) ve harf aralığı
 *   kilidi PROFİLDEN gelir, ad tahmini yapılmaz.
 * - Variable fontlarda her adlandırılmış örnek ayrı yüz olarak yüklenir ("Cinzel/Regular", "Cinzel/Bold");
 *   profil girdisi stil belirtmezse Regular örneği kullanılır.
 * - Yedek zinciri GRAFEM KÜMESİ bazındadır ve sırası sabittir: ortak klasör → uygulamayla gelenler
 *   (`BUNDLED_FONTS_DIR`: Twemoji, Noto Sans/Symbols/Math, tam genişlik) → sistem. Emoji sunumlu kümede (❤️, 🙏🏽,
 *   🇹🇷) önce renkli emoji fontu, diğerlerinde (★, ♥, 𝓔) önce yazı yedeği; kümeyi TEK parça basan font, parçalara
 *   ayırarak basandan (ZWJ dizisinin bileşenleri yan yana) önce gelir. Uygulama ve sistem yedekleri yalnız
 *   gerektiğinde yüklenir; sonuç yükleme sırasına bağlı değildir (aynı metin her zaman aynı fontla basılır).
 * - Hiçbir font basamıyorsa `resolve`/`fallbackFor` null döner; çağıran bunu raporlar (karakter asla silinmez).
 * - Dış hattı (vektör çizimi) olmayan fontlar (bitmap renkli emoji: CBDT/sbix) ve yalnız COLRv1 katmanlı fontlar yedek
 *   olarak alınmaz (çizilemezler; sessizce boş basılırdı), `problems`'e yazılır.
 */

/** Uygulamayla gelen yedek fontlar (lisanslar ve kaynaklar: `fonts/KAYNAKLAR.txt`). */
export const BUNDLED_FONTS_DIR = path.resolve(import.meta.dirname, "..", "fonts");

export type FallbackKind = "text" | "emoji";

/** Uygulamayla gelen yedekler, zincir sırasıyla (tür sırası ayrıca uygulanır: emoji kümesinde önce emoji fontu). */
const BUNDLED_FALLBACKS: ReadonlyArray<readonly [file: string, kind: FallbackKind]> = [
  ["Twemoji.ttf", "emoji"],
  ["NotoSans-Regular.ttf", "text"],
  ["NotoNaskhArabic[wght].ttf", "text"],
  ["NotoSansSymbols2-Regular.ttf", "text"],
  ["NotoSansSymbols[wght].ttf", "text"],
  ["NotoSansMath-Regular.ttf", "text"],
  ["MPLUS1p-Regular-tamgenislik.ttf", "text"],
];

/** Uygulamayla gelen yedek font dosyası (zincir sırasıyla; web'e sunmak için). */
export interface BundledFont {
  file: string;
  path: string;
  kind: FallbackKind;
}

/** Uygulamayla gelen yedek fontlar, zincir sırasıyla (renkli emoji fontu ilk). */
export function bundledFallbackFonts(): BundledFont[] {
  return BUNDLED_FALLBACKS.map(([file, kind]) => ({ file, path: path.join(BUNDLED_FONTS_DIR, file), kind }));
}

/**
 * Kümenin font seçimi. `partial`: font kümeyi tek parça basamıyor, bileşenlerini yan yana basıyor (ör. yeni ZWJ
 * emojisi). `monochrome`: emoji sunumlu küme renkli bir fontta yok, tek renk (sembol fontuyla) basılacak.
 */
export interface Resolved {
  fontId: string;
  fallback: boolean;
  partial: boolean;
  monochrome: boolean;
}

export interface FontFace {
  /** Kayıt kimliği: profil girdisinin kimliği ya da "Aile/Stil" (aynı adlı ikinci yedek: "Aile/Stil (2)"). */
  id: string;
  /** Figma'daki aile ve stil adı (profil girdisinden; yoksa dosyadan). */
  family: string;
  style: string;
  /** Dosyanın kendi aile adı (aynı ailede ağır stil aramak için). */
  fileFamily: string;
  file: string;
  /** Yüzün dosyadaki kimliği (dosya + örnek adı); önbellek anahtarı, kayıt kimliğinden bağımsız. */
  source: string;
  upem: number;
  /** Font birimi; ascender pozitif, descender negatif. */
  ascender: number;
  descender: number;
  capHeight: number;
  xHeight: number;
  weight: number;
  italic: boolean;
  /** Renkli (COLR) glifleri var mı (emoji). */
  color: boolean;
  fallback: FallbackKind | null;
  /** Profilden gelen tür; profil dışı yüzlerde null. */
  kind: FontKind | null;
  /** Harf aralığı uygulanmaz (profilden). */
  lockTracking: boolean;
}

interface Loaded {
  face: FontFace;
  hbFace: hb.Face;
  hbFont: hb.Font;
  unicodes: Set<number>;
}

export interface FontRegistryOptions {
  /** Profilin font listesi. */
  entries?: readonly FontEntry[];
  /** Tasarım dilinin font klasörü. */
  fontDir?: string;
  /** Ortak yedek font klasörleri (sırayla denenir). */
  fallbackDirs?: readonly string[];
  /** Uygulamayla gelen yedekler (`BUNDLED_FONTS_DIR`: emoji, sembol, süslü yazı). Varsayılan: açık. */
  bundledFallbacks?: boolean;
  /**
   * Sistem yedekleri (`system-fonts.ts`: Windows'ta Segoe UI Symbol/Emoji ve Arial, macOS'ta Apple Symbols ve
   * Arial Unicode, Linux'ta Noto Sans Symbols 2 ve DejaVu Sans; yalnız bulunanlar). Varsayılan: açık, her platformda.
   * Klasörler `TAGPRESS_SYSTEM_FONT_DIRS` ile değişir (boş = kapalı).
   */
  systemFallbacks?: boolean;
  /** Sistem yedeklerinin aranacağı klasörler (varsayılan: `systemFontDirs()`; testler sahte klasör verir). */
  systemFontDirs?: readonly string[];
}

const FONT_FILE = /\.(ttf|otf|ttc)$/i;

/** Kapsama denetiminde sayılmayan kod noktaları (birleştiriciler, varyasyon seçicileri, etiketler). */
function ignorable(cp: number): boolean {
  return cp === 0x200d || cp === 0x200c || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || isTag(cp);
}
const isTag = (cp: number) => cp >= 0xe0020 && cp <= 0xe007f;

/** Kümenin fontta desteği: 0 yok, 1 parçalı (bileşenler yan yana), 2 tam. */
type Support = 0 | 1 | 2;

const STYLE_WEIGHTS: Array<[RegExp, number]> = [
  [/extra\s*black|ultra\s*black/i, 950],
  [/black|heavy/i, 900],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/bold/i, 700],
  [/medium/i, 500],
  [/extra\s*light|ultra\s*light/i, 200],
  [/thin|hairline/i, 100],
  [/light/i, 300],
];

function weightOf(style: string, variations: Record<string, number> | null): number {
  if (variations && typeof variations.wght === "number") return variations.wght;
  for (const [re, w] of STYLE_WEIGHTS) if (re.test(style)) return w;
  return 400;
}

/** Variable fontlarda fontkit aile adına varsayılan örneğin adını ekleyebiliyor ("Nunito ExtraLight"). */
function baseFamily(name: string, instances: string[]): string {
  for (const inst of instances) if (inst !== "Regular" && name.endsWith(` ${inst}`)) return name.slice(0, -inst.length - 1);
  return name;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

type FkFont = fontkit.Font & {
  namedVariations?: Record<string, Record<string, number>>;
  capHeight?: number;
  xHeight?: number;
  italicAngle?: number;
  directory?: { tables?: Record<string, unknown> };
};

/** Dosyadan açılmış yüzler (kayda bağlı kimlik hariç). Uygulamayla gelen dosyalar bir kez açılır, kayıtlar paylaşır. */
type Opened = Array<Omit<Loaded, "face"> & { face: Omit<FontFace, "id"> & { id: string } }>;
const sharedOpen = new Map<string, Opened>();

/**
 * Font dosyasını açar. `fallback` verilmişse (yedek) dış hattı olmayan ya da yalnız COLRv1 katmanlı font reddedilir:
 * bu çizici onları çizemez, karakter sessizce boş basılırdı.
 */
function openFile(file: string, fallback: FallbackKind | "auto" | null): Opened {
  const data = readFileSync(file);
  const opened = fontkit.create(data) as unknown as FkFont | { fonts: FkFont[] };
  const faces: FkFont[] = "fonts" in opened ? opened.fonts : [opened];
  const blob = new hb.Blob(data);
  const out: Opened = [];
  faces.forEach((fk, index) => {
    const hbFace = new hb.Face(blob, index);
    const unicodes = new Set<number>(hbFace.collectUnicodes());
    const layers = hbFace.hasColorLayers();
    const paint = hbFace.hasColorPaint();
    const color = layers || paint;
    if (fallback) {
      const tables = fk.directory?.tables ?? {};
      if (!("glyf" in tables) && !("CFF " in tables) && !("CFF2" in tables))
        throw new Error("vektör çizimi (dış hat) yok; bitmap renkli emoji fontları (CBDT/sbix) çizilemez");
      if (paint && !layers) throw new Error("yalnız COLRv1 renk katmanları var; bu sürüm COLRv0 (Twemoji gibi) çizer");
    }
    const named = fk.namedVariations ?? {};
    const instNames = Object.keys(named);
    const family = baseFamily(fk.familyName, instNames);
    let instances: Array<[string, Record<string, number> | null]> = instNames.length
      ? instNames.map((n) => [n, named[n] ?? null])
      : [[fk.subfamilyName || "Regular", null]];
    // Yedek fontta yalnızca Regular (ya da varsayılan) örnek.
    if (fallback && instances.length > 1) instances = [instances.find(([n]) => n === "Regular") ?? instances[0]!];
    for (const [style, variations] of instances) {
      const hbFont = new hb.Font(hbFace);
      if (variations) hbFont.setVariations(Object.entries(variations).map(([tag, v]) => new hb.Variation(tag, v)));
      const upem = hbFace.upem;
      const capHeight = (fk.capHeight ?? 0) > 0 ? fk.capHeight! : glyphTop(hbFont, 0x48) || 0.7 * upem;
      const xHeight = (fk.xHeight ?? 0) > 0 ? fk.xHeight! : glyphTop(hbFont, 0x78) || 0.5 * upem;
      const kind: FallbackKind | null = fallback === "auto" ? (color ? "emoji" : "text") : fallback;
      out.push({
        hbFace,
        hbFont,
        unicodes,
        face: {
          id: `${family}/${style}`,
          family,
          style,
          fileFamily: family,
          file,
          source: `${path.resolve(file)}#${index}#${style}`,
          upem,
          ascender: fk.ascent,
          descender: fk.descent,
          capHeight,
          xHeight,
          weight: weightOf(style, variations),
          italic: /italic|oblique/i.test(style) || (fk.italicAngle ?? 0) !== 0,
          color,
          fallback: kind,
          kind: null,
          lockTracking: false,
        },
      });
    }
  });
  return out;
}

export class FontRegistry {
  private readonly byId = new Map<string, Loaded>();
  /** Dosyadan yüklenen bütün tasarım yüzleri (profil dışı örnekler dahil). */
  private readonly designFaces: Loaded[] = [];
  /** Yedekler, zincir sırasıyla (ortak klasör, uygulamayla gelenler, sistem). */
  private readonly fallbacks: Loaded[] = [];
  /** Uygulamayla gelen yedekler henüz yüklenmedi (yalnız gerektiğinde yüklenir). */
  private bundledPending = false;
  /** Sistem yedekleri henüz aranmadı (yalnızca gerektiğinde aranır ve yüklenir). */
  private systemPending = false;
  private systemDirs: readonly string[] | undefined;
  private readonly supportCache = new Map<string, Support>();
  /** Yükleme ve eşleme sorunları (kullanıcıya gösterilir). */
  readonly problems: string[] = [];

  /** Klasörleri tarar, profil girdilerini eşler. */
  static async create(opts: FontRegistryOptions = {}): Promise<FontRegistry> {
    return FontRegistry.createSync(opts);
  }

  /** `create`'in eşzamanlı hâli (yükleme zaten eşzamanlı; sunucunun eşzamanlı kapsam denetimi için). */
  static createSync(opts: FontRegistryOptions = {}): FontRegistry {
    const reg = new FontRegistry();
    if (opts.fontDir) {
      for (const file of listFonts(opts.fontDir)) reg.tryLoad(file, null);
    }
    for (const dir of opts.fallbackDirs ?? []) {
      for (const file of listFonts(dir)) reg.tryLoad(file, "auto");
    }
    reg.bundledPending = opts.bundledFallbacks ?? true;
    reg.systemPending = opts.systemFallbacks ?? true;
    reg.systemDirs = opts.systemFontDirs;
    for (const entry of opts.entries ?? []) reg.mapEntry(entry, opts.fontDir);
    return reg;
  }

  /** Tek dosya yükler (testler ve sunucu için). `fallback`: "auto" = renkli ise emoji, değilse yazı yedeği. */
  addFile(file: string, fallback: FallbackKind | "auto" | null = null): FontFace[] {
    return this.register(openFile(file, fallback));
  }

  private register(opened: Opened): FontFace[] {
    const out: FontFace[] = [];
    for (const o of opened) {
      const face: FontFace = { ...o.face };
      if (face.fallback) {
        // Aynı adlı ikinci yedek (ör. ortak klasördeki ve uygulamadaki Twemoji) kendi kimliğini alır.
        for (let n = 2; this.byId.has(face.id); n++) face.id = `${o.face.id} (${n})`;
      }
      const loaded: Loaded = { face, hbFace: o.hbFace, hbFont: o.hbFont, unicodes: o.unicodes };
      if (face.fallback) this.fallbacks.push(loaded);
      else this.designFaces.push(loaded);
      if (!this.byId.has(face.id)) this.byId.set(face.id, loaded);
      out.push(face);
    }
    return out;
  }

  private tryLoad(file: string, fallback: FallbackKind | "auto" | null, shared = false): void {
    try {
      let opened = shared ? sharedOpen.get(file) : undefined;
      if (!opened) {
        opened = openFile(file, fallback);
        if (shared) sharedOpen.set(file, opened);
      }
      this.register(opened);
    } catch (err) {
      this.problems.push(`${path.basename(file)} yüklenemedi: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Profil girdisini yüklü bir yüze bağlar; kimlik, Figma adları, tür ve kilit profilden gelir. */
  mapEntry(entry: FontEntry, fontDir?: string): boolean {
    let candidates = this.designFaces;
    if (entry.file) {
      const wanted = fontDir ? path.resolve(fontDir, entry.file) : entry.file;
      const fromFile = this.designFaces.filter((l) => path.resolve(l.face.file) === path.resolve(wanted) || path.basename(l.face.file) === path.basename(entry.file!));
      if (!fromFile.length && existsSync(wanted)) {
        this.tryLoad(wanted, null);
        candidates = this.designFaces.filter((l) => path.resolve(l.face.file) === path.resolve(wanted));
      } else candidates = fromFile;
    } else {
      candidates = this.designFaces.filter((l) => norm(l.face.family) === norm(entry.family));
    }
    const style = norm(entry.style || "Regular");
    const hit = candidates.find((l) => norm(l.face.style) === style) ?? candidates.find((l) => norm(l.face.style) === "regular") ?? candidates[0];
    if (!hit) {
      this.problems.push(`Font dosyası bulunamadı: ${entry.id}${entry.file ? ` (${entry.file})` : ""}`);
      return false;
    }
    const face: FontFace = { ...hit.face, id: entry.id, family: entry.family, style: entry.style || "Regular", kind: entry.kind, lockTracking: entry.lockTracking };
    this.byId.set(entry.id, { ...hit, face });
    return true;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): FontFace {
    return this.loaded(id).face;
  }

  /** Bütün kayıtlı yüzler (yedekler hariç). */
  list(): FontFace[] {
    return [...this.byId.values()].filter((l) => !l.face.fallback).map((l) => l.face);
  }

  /** @internal harfbuzz font nesnesi. */
  hbFont(id: string): hb.Font {
    return this.loaded(id).hbFont;
  }

  /** @internal harfbuzz yüz nesnesi. */
  hbFace(id: string): hb.Face {
    return this.loaded(id).hbFace;
  }

  /** Grafemi bu font basabilir mi (her kod noktası fontta; birleştirici ve seçiciler sayılmaz)? */
  covers(id: string, grapheme: string): boolean {
    return coversSet(this.loaded(id).unicodes, grapheme);
  }

  /** Metindeki, fontun basamadığı grafemler (boşluklar hariç). */
  missing(id: string, text: string): string[] {
    const out = new Set<string>();
    for (const g of graphemes(text)) if (!/^\s+$/u.test(g) && !this.covers(id, g)) out.add(g);
    return [...out];
  }

  /**
   * Kümenin fontu: `own` (satırın tasarım fontu) basabiliyorsa o; emoji sunumlu kümede (❤️, ©️) ise önce TAM
   * destekleyen renkli emoji fontu (yoksa tasarım fontu); basamıyorsa yedek zinciri. Hiçbiri basamıyorsa null.
   */
  resolve(grapheme: string, own: string): Resolved | null {
    const emoji = isEmojiGrapheme(grapheme);
    const ownCovers = this.has(own) && this.covers(own, grapheme);
    if (ownCovers && !emoji) return { fontId: own, fallback: false, partial: false, monochrome: false };
    const fb = this.pickFallback(grapheme);
    if (ownCovers && !(fb && fb.rank === 0)) return { fontId: own, fallback: false, partial: false, monochrome: emoji && !this.get(own).color };
    if (!fb) return null;
    return { fontId: fb.loaded.face.id, fallback: true, partial: fb.support === 1, monochrome: emoji && !fb.loaded.face.color };
  }

  /** Grafemi basabilen yedek font (bkz. `resolve`); hiçbiri basamıyorsa null. */
  fallbackFor(grapheme: string): string | null {
    return this.pickFallback(grapheme)?.loaded.face.id ?? null;
  }

  /**
   * Zincirdeki en iyi yedek. Sıra: istenen türde tam destek (0) → istenen türde parçalı (1) → öbür türde tam (2) →
   * öbür türde parçalı (3); eşitlikte zincirde önce gelen. Uygulama/sistem yedekleri yalnız yüklü olanlar arasında
   * en iyi (0) bulunamazsa yüklenir; zincire sona eklendikleri için sonuç yükleme geçmişine bağlı değildir.
   */
  private pickFallback(g: string): { loaded: Loaded; rank: number; support: Support } | null {
    let best = this.best(g);
    if (best?.rank === 0) return best;
    if (this.bundledPending) {
      this.bundledPending = false;
      for (const [file, kind] of BUNDLED_FALLBACKS) this.tryLoad(path.join(BUNDLED_FONTS_DIR, file), kind, true);
      best = this.best(g);
      if (best?.rank === 0) return best;
    }
    if (this.systemPending) {
      // Sistem yedekleri büyük dosyalar; yalnızca gerektiğinde aranır ve yüklenir.
      this.systemPending = false;
      for (const f of findSystemFonts(SYSTEM_TEXT_FALLBACKS, this.systemDirs ?? systemFontDirs())) this.tryLoad(f, "auto");
      best = this.best(g);
    }
    return best;
  }

  private best(g: string): { loaded: Loaded; rank: number; support: Support } | null {
    const want: FallbackKind = isEmojiGrapheme(g) ? "emoji" : "text";
    let best: { loaded: Loaded; rank: number; support: Support } | null = null;
    for (const l of this.fallbacks) {
      const support = this.support(l, g);
      if (!support) continue;
      const rank = (l.face.fallback === want ? 0 : 2) + (support === 2 ? 0 : 1);
      if (!best || rank < best.rank) best = { loaded: l, rank, support };
      if (rank === 0) break;
    }
    return best;
  }

  /**
   * Fontun kümeye desteği. Tam: bütün kod noktaları fontta ve küme şekillendirilince TEK görünür glif (ZWJ dizisi,
   * bayrak, ten rengi tek resim). Parçalı: kod noktaları var ama glifler yan yana (🐦+ZWJ+🔥 → 🐦🔥) ya da etiket dizili
   * bayrağın etiketleri fontta yok (🏴 olarak basılır).
   */
  private support(l: Loaded, g: string): Support {
    const key = `${l.face.source}\u0000${g}`;
    const hit = this.supportCache.get(key);
    if (hit !== undefined) return hit;
    let s: Support = 0;
    if (coversSet(l.unicodes, g)) {
      const cps = [...g].map((c) => c.codePointAt(0)!);
      const glyphs = visibleGlyphs(l.hbFont, g);
      // Çizimsiz glif (emoji fontunda yalnız tuş kapağı ligatürü için duran rakam gibi) basılmış sayılmaz.
      if (!/^\s+$/u.test(g) && (!glyphs.length || glyphs.some((gid) => blankGlyph(l, gid)))) s = 0;
      else if (cps.some((cp) => isTag(cp) && !l.unicodes.has(cp))) s = 1;
      else s = glyphs.length > 1 ? 1 : 2;
    }
    this.supportCache.set(key, s);
    return s;
  }

  /**
   * Aynı ailede daha ağır stil (gerçek kalın). Variable fontta adlandırılmış örnekler ayrı yüzdür.
   * Font zaten kalınsa ya da ailede daha ağırı yoksa null.
   */
  heavier(id: string): FontFace | null {
    const base = this.get(id);
    if (base.fallback || base.weight >= 700) return null;
    const cands = this.designFaces
      .map((l) => l.face)
      .filter((f) => f.fileFamily === base.fileFamily && f.italic === base.italic && f.weight >= base.weight + 100);
    if (!cands.length) return null;
    return cands.sort((a, b) => Math.abs(a.weight - 700) - Math.abs(b.weight - 700))[0]!;
  }

  private loaded(id: string): Loaded {
    const l = this.byId.get(id);
    if (!l) throw new Error(`Bilinmeyen font: ${id}`);
    return l;
  }
}

function coversSet(unicodes: Set<number>, g: string): boolean {
  for (const ch of g.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (!ignorable(cp) && !unicodes.has(cp)) return false;
  }
  return true;
}

/** Küme şekillendirilince ilerlemesi olan glifler (gizli birleştirici/seçici ve işaretler sayılmaz). */
function visibleGlyphs(font: hb.Font, g: string): number[] {
  const buffer = new hb.Buffer();
  buffer.addText(g);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  return buffer
    .getGlyphInfosAndPositions()
    .filter((x) => (x.xAdvance ?? 0) > 0)
    .map((x) => x.codepoint);
}

/** Glifin ne çizimi ne renk katmanı var (boşluk değilse görünmez basılır). */
function blankGlyph(l: Loaded, gid: number): boolean {
  const e = l.hbFont.glyphExtents(gid);
  if (e && e.width !== 0 && e.height !== 0) return false;
  return l.hbFace.getGlyphColorLayers(gid).length === 0;
}

function glyphTop(font: hb.Font, cp: number): number {
  const gid = font.nominalGlyph(cp);
  if (!gid) return 0;
  const e = font.glyphExtents(gid);
  return e ? e.yBearing : 0;
}

function listFonts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FONT_FILE.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Grafem kümeleri (tek kaynak: `@tagpress/domain` `graphemes`). */
export const segmentGraphemes = graphemes;
