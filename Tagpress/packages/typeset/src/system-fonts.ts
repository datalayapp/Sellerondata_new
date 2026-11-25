import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tagpressEnv } from "@tagpress/domain/env";

/**
 * Sistem fontları: tasarım dilinin ve ortak klasörün basamadığı karakterler için SON yedek. İsteğe bağlıdır:
 * `TAGPRESS_SYSTEM_FONT_DIRS` (eski adı `STUDIO_SYSTEM_FONT_DIRS` da kabul edilir) verilirse yalnız o klasörler aranır (`path.delimiter` ile ayrılır; boş değer = kapalı),
 * verilmezse platformun bilinen font klasörleri. Bulunamayan dosya sessizce atlanır; hiçbir platform zorunlu değildir.
 */

/** Yazı yedekleri (sırayla): Windows, macOS, Linux adları; yalnız bulunanlar kullanılır. */
export const SYSTEM_TEXT_FALLBACKS: readonly string[] = [
  "seguisym.ttf",
  "seguiemj.ttf",
  "arial.ttf",
  "Apple Symbols.ttf",
  "Arial Unicode.ttf",
  "NotoSansSymbols2-Regular.ttf",
  "DejaVuSans.ttf",
];

/** Kalın yazı yedekleri (ör. hücre etiketi): Windows, macOS, Linux adları. */
export const SYSTEM_BOLD_FALLBACKS: readonly string[] = ["arialbd.ttf", "segoeuib.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"];

type Env = Readonly<Record<string, string | undefined>>;

/** Aranacak sistem font klasörleri. */
export function systemFontDirs(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string[] {
  const override = tagpressEnv("SYSTEM_FONT_DIRS", env);
  if (override !== undefined) {
    return override
      .split(path.delimiter)
      .map((d) => d.trim())
      .filter(Boolean);
  }
  if (platform === "win32") {
    const win = env.WINDIR ?? env.SystemRoot;
    return [...(win ? [path.join(win, "Fonts")] : []), ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts")] : [])];
  }
  if (platform === "darwin") return ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(home, "Library", "Fonts")];
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return [path.join(dataHome, "fonts"), path.join(home, ".fonts"), "/usr/local/share/fonts", "/usr/share/fonts"];
}

const FONT_FILE = /\.(ttf|otf|ttc)$/i;
const MAX_DEPTH = 4;
const indexCache = new Map<string, Map<string, string>>();

/** Klasörlerdeki font dosyaları: küçük harfli dosya adı → ilk bulunan yol (alt klasörler dahil, sınırlı derinlik). */
function fontIndex(dirs: readonly string[]): Map<string, string> {
  const key = dirs.join("\0");
  const hit = indexCache.get(key);
  if (hit) return hit;
  const index = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // klasör yok ya da okunamıyor
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1);
      } else if (FONT_FILE.test(e.name) && !index.has(e.name.toLowerCase())) index.set(e.name.toLowerCase(), full);
    }
  };
  for (const d of dirs) walk(d, 0);
  indexCache.set(key, index);
  return index;
}

/** Adı verilen font dosyalarından sistem klasörlerinde bulunanların yolları (verilen sırayla; ad büyük/küçük harf duyarsız). */
export function findSystemFonts(names: readonly string[], dirs: readonly string[] = systemFontDirs()): string[] {
  if (!dirs.length) return [];
  const index = fontIndex(dirs);
  const out: string[] = [];
  for (const n of names) {
    const f = index.get(n.toLowerCase());
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}
