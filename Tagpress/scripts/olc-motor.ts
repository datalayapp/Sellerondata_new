/**
 * AI'sız motor ölçümü: kullanıcının bitmiş etiketlerinin (referanslar) satırlarını motora verir, sonucu kullanıcının
 * mürekkep kutularıyla karşılaştırır. Eski sistemin değeri (aynı küme): ±%10 boyut 143/214.
 *
 *   pnpm olc:motor [--dil benim-tarzim] [--split test|train] [--oranlar] [--satir] [--fill 0.94]
 *     --oranlar  kullanıcının kendi satır oranlarıyla (profil sınıfları yerine)
 *     --satir    eski "bütün satır kutusu" sığdırma modeli
 *     --fill     profilin doluluğu yerine bu değer (yalnızca ölçüm; profil dosyasına yazılmaz)
 *     --json     iş başı sonuçları bu dosyaya yazar (kabul ölçümüyle iş iş karşılaştırmak için)
 *
 * Yalnızca okur: paket ve referanslar `TAGPRESS_DATA_DIR` (yoksa `data/`) altından okunur; veri klasörüne hiçbir şey
 * yazılmaz (yalnızca `--json` ile verilen dosya).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProfileSchema, ReferenceSchema, TemplateSchema, upgradeProfileInput } from "@tagpress/domain";
import { formatReplaySummary, replayReference, summarizeReplays } from "@tagpress/engine";
import { buildGeometry } from "@tagpress/templates";
import { FontRegistry } from "@tagpress/typeset";
import { tagpressEnv } from "@tagpress/domain/env";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dil = arg("--dil") ?? "benim-tarzim";
const split = arg("--split");
const data = tagpressEnv("DATA_DIR") ?? path.resolve(import.meta.dirname, "..", "data");
const pkgDir = path.join(data, "aktarim", dil);

const pkg = JSON.parse(readFileSync(path.join(pkgDir, "paket.json"), "utf8")) as { profile: unknown; templates: unknown[] };
const fillArg = arg("--fill");
// Aktarım paketi eski adlı alanlarla durabilir (ör. `figma.frameName`): önce bugünkü adlara çevrilir.
const rawProfile = upgradeProfileInput(pkg.profile) as { sizing: object };
const profile = ProfileSchema.parse(fillArg === undefined ? rawProfile : { ...rawProfile, sizing: { ...rawProfile.sizing, fill: Number(fillArg) } });
const templates = new Map(pkg.templates.map((t) => TemplateSchema.parse(t)).map((t) => [t.key, t]));
const refs = (JSON.parse(readFileSync(path.join(pkgDir, "referanslar.json"), "utf8")) as unknown[])
  .map((r) => ReferenceSchema.parse(r))
  .filter((r) => r.labelFramePx === profile.output.designFramePx && (!split || r.split === split));

const fonts = await FontRegistry.create({
  entries: profile.fonts.list,
  fontDir: path.join(data, "diller", dil, "fontlar"),
  fallbackDirs: [path.join(data, "ortak", "fontlar")],
});

const t0 = Date.now();
const metrics = [];
let skipped = 0;
for (const ref of refs) {
  const tpl = ref.templateKey ? templates.get(ref.templateKey) : undefined;
  if (!tpl) {
    skipped++;
    continue;
  }
  const geometry = await buildGeometry(tpl, profile, { imagePath: path.join(data, "diller", dil, "sablonlar", tpl.file) });
  metrics.push(await replayReference(ref, profile, geometry, fonts, { userRatios: process.argv.includes("--oranlar"), fit: process.argv.includes("--satir") ? "line" : "glyph" }));
}
console.log(`doluluk ${profile.sizing.fill}${fillArg === undefined ? " (profil)" : " (--fill)"} · küme ${split ?? "hepsi"}`);
console.log(formatReplaySummary(summarizeReplays(metrics)));
console.log(`${refs.length} referans, ${skipped} şablonu olmadığı için atlandı · ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
// İsteğe bağlı iş başı döküm (kabul ölçümüyle iş iş karşılaştırmak için): --json çıktı.json
const jsonOut = arg("--json");
if (jsonOut) {
  const byId = new Map(refs.map((r) => [r.id, r]));
  const rows = metrics.map((m) => ({
    id: byId.get(m.id)?.orderNo ?? m.id,
    sablon: m.templateKey,
    kullanici: (byId.get(m.id)?.user ?? []).map((l) => l.text.trim()).filter(Boolean).join(" / "),
    oran: Math.round(m.sizeRatio * 1000) / 1000,
    icinde: m.within10,
    ok: m.ok,
  }));
  writeFileSync(jsonOut, JSON.stringify({ fill: profile.sizing.fill, split: split ?? "hepsi", rows }, null, 1));
}
