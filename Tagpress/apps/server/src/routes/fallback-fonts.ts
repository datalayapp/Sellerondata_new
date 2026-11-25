import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FontRegistry, bundledFallbackFonts } from "@tagpress/typeset";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { PLATFORM_PREFIX } from "../platform/identity.ts";

/**
 * Uygulamayla gelen yedek fontlar (emoji, sembol, süslü yazı, Arapça) web'e SALT OKUNUR sunulur: arayüz, metni baskıyla
 * aynı çizimle (Twemoji vb.) gösterebilsin. Dosyalar uygulamanın parçasıdır (`packages/typeset/fonts`), kullanıcı verisi
 * değildir; yalnız listedeki dosyalar sunulur (yol geçişi yok).
 *
 * - `GET /api/fallback-fonts` → `{ fonts: FallbackFontInfo[], css: "/api/fallback-fonts.css" }` (zincir sırasıyla).
 * - `GET /api/fallback-fonts/:file?v=<sha256 ilk 16>` → font baytları (`font/ttf`), bir yıl `immutable` önbellek, ETag.
 * - `GET /api/fallback-fonts.css` → her font için `@font-face` ("TagPress <aile>") ve `--tagpress-yedek-fontlar` yığını.
 * Platform kipinde adresler dış yolla (`/api/tagpress/fallback-fonts/…`) üretilir ve önbellek `private`'tır.
 */

export const FALLBACK_FONTS_PATH = "/api/fallback-fonts";
export const FALLBACK_FONTS_CSS_PATH = "/api/fallback-fonts.css";

export interface FallbackFontInfo {
  file: string;
  /** Fontun kendi aile adı. */
  family: string;
  /** CSS'te kullanılacak ad (sistemde aynı adlı fontla karışmasın). */
  cssFamily: string;
  kind: "emoji" | "text";
  bytes: number;
  sha256: string;
  /** Sürümlü adres (içerik değişince değişir). */
  url: string;
}

interface Loaded {
  info: FallbackFontInfo;
  data: Buffer;
}

let cache: Map<string, Loaded> | null = null;

/** Dosyalar bir kez okunur (uygulamanın parçası, çalışırken değişmez). */
function fonts(): Map<string, Loaded> {
  if (cache) return cache;
  const reg = FontRegistry.createSync({ bundledFallbacks: false, systemFallbacks: false });
  const out = new Map<string, Loaded>();
  for (const f of bundledFallbackFonts()) {
    const data = readFileSync(f.path);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const family = reg.addFile(f.path, null)[0]?.family ?? f.file;
    out.set(f.file, {
      data,
      info: {
        file: f.file,
        family,
        cssFamily: `TagPress ${family}`,
        kind: f.kind,
        bytes: data.length,
        sha256,
        url: `${FALLBACK_FONTS_PATH}/${encodeURIComponent(f.file)}?v=${sha256.slice(0, 16)}`,
      },
    });
  }
  cache = out;
  return out;
}

/** Dış adres: platform kipinde iç yol `/api/…` dışarıda `/api/tagpress/…` (plan §S3); CSS'teki adresi tarayıcı kendisi çözer. */
function externalUrl(url: string, platform: boolean): string {
  return platform && url.startsWith("/api/") ? `${PLATFORM_PREFIX}/${url.slice("/api/".length)}` : url;
}

function css(platform: boolean): string {
  const list = [...fonts().values()].map((f) => f.info);
  const faces = list.map((f) => `@font-face {\n  font-family: "${f.cssFamily}";\n  src: url("${externalUrl(f.url, platform)}") format("truetype");\n  font-display: swap;\n}`);
  const stack = list.map((f) => `"${f.cssFamily}"`).join(", ");
  return `/* TagPress uygulamayla gelen yedek fontlar (baskıyla aynı emoji/sembol çizimi). */\n${faces.join("\n")}\n:root {\n  --tagpress-yedek-fontlar: ${stack};\n}\n`;
}

export function fallbackFontRoutes(app: FastifyInstance, ctx: AppContext): void {
  const platform = ctx.config.auth === "platform";
  // Platformda uçlar kimlik ister: yanıt paylaşılan önbelleğe girmez (`private`).
  const scope = platform ? "private" : "public";
  app.get(FALLBACK_FONTS_PATH, async () => ({
    fonts: [...fonts().values()].map((f) => ({ ...f.info, url: externalUrl(f.info.url, platform) })),
    css: externalUrl(FALLBACK_FONTS_CSS_PATH, platform),
  }));

  app.get(FALLBACK_FONTS_CSS_PATH, async (_req, reply) => reply.header("content-type", "text/css; charset=utf-8").header("cache-control", `${scope}, max-age=3600`).send(css(platform)));

  app.get<{ Params: { file: string } }>(`${FALLBACK_FONTS_PATH}/:file`, async (req, reply) => {
    const f = fonts().get(req.params.file);
    if (!f) return reply.code(404).send({ error: "Böyle bir yedek font yok." });
    const etag = `"${f.info.sha256}"`;
    reply.header("etag", etag).header("cache-control", `${scope}, max-age=31536000, immutable`);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.header("content-type", "font/ttf").send(f.data);
  });
}
