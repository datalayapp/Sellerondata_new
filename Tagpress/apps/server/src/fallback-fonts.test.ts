import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED_FONTS_DIR } from "@tagpress/typeset";
import { type TestApp, makeApp } from "./test/helpers.ts";

/**
 * Uygulamayla gelen yedek fontlar web'e salt okunur sunulur: arayüz önizlemesi baskıyla aynı emoji/sembol çizimini
 * kullanabilsin (tarayıcının kendi emoji fontu yerine Twemoji).
 */
describe("yedek font ucu", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(() => t.close());

  it("liste: dosya, aile, tür, boyut, sha256, adres; emoji fontu ilk sırada", async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/fallback-fonts" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { fonts: Array<{ file: string; family: string; cssFamily: string; kind: string; bytes: number; sha256: string; url: string }>; css: string };
    expect(body.fonts[0]).toMatchObject({ kind: "emoji", family: "Twemoji" });
    for (const f of body.fonts) {
      const bytes = readFileSync(path.join(BUNDLED_FONTS_DIR, f.file));
      expect(f.bytes).toBe(bytes.length);
      expect(f.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(f.url).toBe(`/api/fallback-fonts/${encodeURIComponent(f.file)}?v=${f.sha256.slice(0, 16)}`);
    }
    expect(body.css).toBe("/api/fallback-fonts.css");
  });

  it("font dosyası: baytlar aynı, uzun önbellek, ETag ile 304", async () => {
    const list = (await t.app.inject({ method: "GET", url: "/api/fallback-fonts" })).json() as { fonts: Array<{ file: string; url: string; sha256: string }> };
    const emoji = list.fonts[0]!;
    const r = await t.app.inject({ method: "GET", url: emoji.url });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("font/ttf");
    expect(String(r.headers["cache-control"])).toContain("immutable");
    expect(r.headers.etag).toBe(`"${emoji.sha256}"`);
    expect(r.rawPayload.equals(readFileSync(path.join(BUNDLED_FONTS_DIR, emoji.file)))).toBe(true);
    const again = await t.app.inject({ method: "GET", url: emoji.url, headers: { "if-none-match": `"${emoji.sha256}"` } });
    expect(again.statusCode).toBe(304);
  });

  it("CSS: her font için @font-face", async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/fallback-fonts.css" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/css");
    expect(r.body).toContain('font-family: "TagPress Twemoji"');
    expect(r.body).toMatch(/src: url\("\/api\/fallback-fonts\/Twemoji\.ttf\?v=[0-9a-f]{16}"\) format\("truetype"\)/);
  });

  it("listede olmayan dosya ve yol geçişi 404", async () => {
    for (const url of ["/api/fallback-fonts/yok.ttf", "/api/fallback-fonts/..%2F..%2Fpackage.json", "/api/fallback-fonts/KAYNAKLAR.txt"]) {
      expect((await t.app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });
});
