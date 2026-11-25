import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { API, type FontItem, type FontList, type Profile, apiPath } from "@tagpress/domain";
import type { DataPaths } from "../config.ts";
import type { FontCatalog } from "../ports.ts";
import { fail } from "../util/errors.ts";
import { safeFileName, writeAtomic } from "../util/files.ts";
import { safeJoin } from "../util/safe-path.ts";

const FONT_EXT = [".ttf", ".otf", ".woff", ".woff2"];

/** Font imzaları: TrueType, OpenType (OTTO), WOFF, WOFF2, TrueType koleksiyonu. */
function looksLikeFont(buf: Buffer): boolean {
  const sig = buf.subarray(0, 4).toString("latin1");
  return ["\u0000\u0001\u0000\u0000", "OTTO", "true", "wOFF", "wOF2", "ttcf"].includes(sig);
}

/** Tasarım dilinin ve ortak (yedek) font klasörlerinin dosyaları. Ad çözümü FontCatalog portundan. */
export class FontService {
  private readonly names = new Map<string, { family: string; style: string } | null>();

  constructor(
    private readonly paths: DataPaths,
    private readonly catalog: () => FontCatalog | null,
  ) {}

  dir(languageId: string, scope: "language" | "shared"): string {
    return scope === "shared" ? this.paths.sharedFonts : this.paths.fonts(languageId);
  }

  async list(languageId: string, profile: Profile): Promise<FontList> {
    const files: FontItem[] = [];
    for (const scope of ["language", "shared"] as const) {
      const dir = this.dir(languageId, scope);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).sort()) {
        if (!FONT_EXT.includes(path.extname(file).toLowerCase())) continue;
        const full = path.join(dir, file);
        const name = await this.describe(full);
        const entry = profile.fonts.list.find((f) => f.file === file || (name && f.family === name.family && f.style === name.style));
        files.push({
          file,
          scope,
          family: name?.family ?? null,
          style: name?.style ?? null,
          profileFontId: scope === "language" ? (entry?.id ?? null) : null,
          size: statSync(full).size,
          specimenUrl: `${apiPath(API.fontSpecimen, { lang: languageId, file })}?scope=${scope}`,
        });
      }
    }
    const present = new Set(files.filter((f) => f.scope === "language").map((f) => f.file));
    const missing = profile.fonts.list.filter((f) => f.file && !present.has(f.file)).map((f) => ({ fontId: f.id, file: f.file ?? null }));
    return { files, missing };
  }

  async upload(languageId: string, fileName: string, data: Buffer): Promise<string> {
    if (!safeFileName(fileName) || !FONT_EXT.includes(path.extname(fileName).toLowerCase())) throw fail("font-file-type");
    if (!looksLikeFont(data)) throw fail("font-invalid");
    const dir = this.dir(languageId, "language");
    await mkdir(dir, { recursive: true });
    const full = safeJoin(dir, fileName, { ext: FONT_EXT });
    if (!full) throw fail("font-file-type");
    await writeAtomic(full, data);
    this.names.delete(full);
    return fileName;
  }

  file(languageId: string, scope: "language" | "shared", fileName: string): string {
    if (!safeFileName(fileName)) throw fail("file-name-invalid");
    const full = safeJoin(this.dir(languageId, scope), fileName, { ext: FONT_EXT });
    if (!full || !existsSync(full)) throw fail("font-file-not-found");
    return full;
  }

  private async describe(full: string): Promise<{ family: string; style: string } | null> {
    if (this.names.has(full)) return this.names.get(full) ?? null;
    const cat = this.catalog();
    const name = cat ? await cat.describe(full).catch(() => null) : null;
    if (cat) this.names.set(full, name);
    return name;
  }
}
