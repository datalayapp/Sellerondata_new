/**
 * Ürünle gelen varsayılan şablonları üretir (SUNUCU-PLANI §2.8): `assets/varsayilan/sablonlar/`.
 *
 *   pnpm exec tsx scripts/varsayilan-sablonlar.mjs [--denetle]
 *
 * Her şablon burada SVG olarak tanımlanır (kendi işimiz, CC0); betik `kaynak/<anahtar>.svg`, `<anahtar>.png` ve
 * kayıt listesini (`sablonlar.json`) yazar. Tekrar üretilebilir: aynı sharp sürümüyle aynı baytlar. `--denetle`
 * hiçbir şey yazmaz; diskteki dosyalar bu tanımlardan üretilenle aynı değilse 1 ile çıkar.
 *
 * Ölçüler varsayılan profilin (`defaultProfile()`, şema varsayılanı) şablon kutusu ve kesim şekline göredir:
 * şablon görseli kutunun 2 katı çözünürlükte (420 → 840 px). Kurdele payı (`ribbonTop`) bandın SVG'deki alt
 * kenarından hesaplanır, elle yazılmaz. Yazı alanı ürünün otomatik önerisiyle bulunur (`area: auto`).
 *
 * Kesim şablon başınadır: daire şablonları `cut` taşımaz (kesimleri tasarım dilinin `output.cut`'ından gelir);
 * `urun-dikdortgen` ve `kare` kendi kesimini (mm) taşır, görseli kesim kutusuna (`templateImageBox`) oturur ve
 * ölçüsü `effectiveCut` ile hesaplanır.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defaultProfile, effectiveCut, templateImageBox } from "../packages/domain/src/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "assets", "varsayilan", "sablonlar");
// sharp kök pakette değil; şablon paketinin bağımlılığından alınır (yeni bağımlılık yok).
const sharp = createRequire(path.join(ROOT, "packages", "templates", "package.json"))("sharp");

const profile = defaultProfile();
const box = profile.output.templateBox; // { x: 10, y: 10, w: 420, h: 420 }
const SCALE = 2;
const SIZE = box.w * SCALE; // 840
const C = SIZE / 2;

// Renkler: sıcak gri-kahve çizgi, krem zemin, açık kum bant (yazı rengi siyah; hepsi açık zeminde okunur).
const LINE = "#8A7866";
const CREAM = "#F4EEE4";
const BAND = "#EADFCF";

const r1 = (v) => Math.round(v * 10) / 10;
const svgDoc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${body}\n</svg>\n`;
const ring = (r, w) => `  <circle cx="${C}" cy="${C}" r="${r}" fill="none" stroke="${LINE}" stroke-width="${w}"/>`;

/** Kesim çapı ve üstü (tasarım px), profilin kesim şeklinden. */
function cutTopAndDiameter() {
  const c = profile.output.cut;
  if (c.kind !== "circle") throw new Error("Varsayılan profilin kesimi daire bekleniyor.");
  return { top: c.cy - c.r, D: 2 * c.r };
}

/** Çapraz dört köşede küçük yaprak süsü (çemberin üstünde). */
function sprigs(R) {
  let out = "";
  for (const deg of [45, 135, 225, 315]) {
    const a = (deg * Math.PI) / 180;
    const x = r1(C + R * Math.cos(a));
    const y = r1(C + R * Math.sin(a));
    // Yerel eksen: x çembere teğet, -y dışa doğru. İki yana ikişer yaprak (biri dışta biri içte), ortada iki tane.
    const leaf = (cx, cy, rx, ry, rot) => `    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${cx} ${cy})"/>\n`;
    out +=
      `  <g transform="translate(${x} ${y}) rotate(${deg + 90})" fill="${LINE}">\n` +
      leaf(-24, -9, 20, 7, 28) +
      leaf(-52, 5, 17, 6, -18) +
      leaf(24, -9, 20, 7, -28) +
      leaf(52, 5, 17, 6, 18) +
      `    <circle cx="0" cy="0" r="7"/>\n` +
      `    <circle cx="0" cy="-17" r="4.5"/>\n` +
      `  </g>\n`;
  }
  return out.trimEnd();
}

/** Üstte yatay kurdele bandı: uçları V kesikli; içinde iki dikiş çizgisi. */
const BAND_TOP = 168;
const BAND_BOTTOM = 252;
function ribbon() {
  const x0 = 112, x1 = SIZE - 112, notch = 24, mid = (BAND_TOP + BAND_BOTTOM) / 2;
  const pts = [
    [x0, BAND_TOP], [x1, BAND_TOP], [x1 - notch, mid], [x1, BAND_BOTTOM], [x0, BAND_BOTTOM], [x0 + notch, mid],
  ].map(([x, y]) => `${x},${y}`).join(" ");
  const stitch = (y) =>
    `  <line x1="${x0 + notch + 14}" y1="${y}" x2="${x1 - notch - 14}" y2="${y}" stroke="${LINE}" stroke-width="2" stroke-dasharray="10 8"/>`;
  return [
    `  <polygon points="${pts}" fill="${BAND}" stroke="${LINE}" stroke-width="3" stroke-linejoin="round"/>`,
    stitch(BAND_TOP + 12),
    stitch(BAND_BOTTOM - 12),
  ].join("\n");
}

/** Bandın alt kenarının kesim üstünden uzaklığı, kesim çapına oran (yukarı yuvarlanır: bant hep kapalı kalır). */
function ribbonTopRatio() {
  const { top, D } = cutTopAndDiameter();
  const bottomDesign = box.y + BAND_BOTTOM / SCALE;
  return Math.ceil(((bottomDesign - top) / D) * 1000) / 1000;
}

/**
 * Şablonlar. `imageBox`: görselin tasarım alanındaki yeri (null = profilin şablon kutusu). Düz dairenin zemini
 * kesim çizgisine kadar dolu olmalı (yoksa kenarda beyaz halka kalır): görsel bütün tasarım alanını kaplar.
 */
const FULL = profile.output.designFramePx; // 440

/** Kendi kesimi olan şablonun görsel ölçüsü: kesim kutusunun 2 katı (kutu `templateImageBox`'tan, elle sayı yok). */
function cutTemplate(key, cut, notes) {
  const tpl = { cut, imageBox: null };
  const b = templateImageBox(tpl, profile);
  const w = Math.round(b.w * SCALE);
  const h = Math.round(b.h * SCALE);
  const inset = Math.round(Math.min(w, h) * 0.04);
  const sw = 4;
  return {
    key,
    notes,
    cut,
    w,
    h,
    sizeId: effectiveCut(tpl, profile).sizeId,
    // Kesimden ~%4 içeride tek ince çizgili dikdörtgen çerçeve; iç alan boş.
    body: () =>
      `  <rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" fill="none" stroke="${LINE}" stroke-width="${sw}"/>`,
  };
}

const TEMPLATES = [
  {
    key: "duz-daire",
    notes: "Düz krem zemin, dekor yok; yazı ortada.",
    imageBox: { x: 0, y: 0, w: FULL, h: FULL },
    size: FULL * SCALE,
    body: () => `  <circle cx="${FULL}" cy="${FULL}" r="${FULL}" fill="${CREAM}"/>`,
  },
  {
    key: "ince-kenar",
    notes: "Kenarda tek ince çizgi; iç alan boş ve dairesel.",
    body: () => ring(388, 4),
  },
  {
    key: "cift-kenar",
    notes: "Kenarda biri kalın biri ince iki çizgi; iç alan boş ve dairesel.",
    body: () => [ring(392, 7), ring(370, 2.5)].join("\n"),
  },
  {
    key: "kurdele",
    notes: "Üstte yatay kurdele bandı (yazıya kapalı); yazı bandın altındaki alanda.",
    ribbonTop: ribbonTopRatio,
    body: () => [ring(388, 3), ribbon()].join("\n"),
  },
  {
    key: "kose-sus",
    notes: "İnce kenar çizgisi; çapraz dört köşede küçük yaprak süsü; iç alan dairesel.",
    body: () => [ring(388, 3), sprigs(388)].join("\n"),
  },
  cutTemplate(
    "urun-dikdortgen",
    { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 },
    "Dikdörtgen ürün etiketi (63,5 × 38,1 mm); ince iç çerçeve; yazı ortada.",
  ),
  cutTemplate("kare", { shape: "rect", wMm: 40, hMm: 40, radiusMm: 0 }, "Kare etiket (40 × 40 mm); ince iç çerçeve; yazı ortada."),
];

async function build() {
  const files = new Map();
  const records = [];
  for (const t of TEMPLATES) {
    const w = t.w ?? t.size ?? SIZE;
    const h = t.h ?? t.size ?? SIZE;
    const svg = svgDoc(w, h, t.body());
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: false }).toBuffer();
    files.set(path.join("kaynak", `${t.key}.svg`), Buffer.from(svg));
    files.set(`${t.key}.png`, png);
    records.push({
      key: t.key,
      file: `${t.key}.png`,
      kind: "label",
      ...(t.cut ? { cut: t.cut } : {}),
      imageBox: t.imageBox ?? null,
      area: { mode: "auto" },
      ribbonTop: t.ribbonTop ? t.ribbonTop() : 0,
      notes: t.notes,
      tags: ["varsayilan"],
    });
  }
  const manifest = {
    aciklama: "Ürünle gelen varsayılan şablonlar (scripts/varsayilan-sablonlar.mjs üretir; elle düzenlemeyin). Lisans: CC0 1.0.",
    lisans: "CC0-1.0",
    sablonlar: records,
  };
  files.set("sablonlar.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return files;
}

const files = await build();
if (process.argv.includes("--denetle")) {
  // Metin dosyaları git'in satır sonu çevirisinden (CRLF) bağımsız karşılaştırılır.
  const text = (rel, buf) => (/\.(svg|json)$/.test(rel) ? Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n")) : buf);
  const stale = [...files].filter(([rel, buf]) => {
    const full = path.join(OUT, rel);
    return !existsSync(full) || !text(rel, readFileSync(full)).equals(buf);
  });
  for (const [rel] of stale) console.log(`farklı ya da eksik: ${rel}`);
  console.log(stale.length ? `${stale.length} dosya güncel değil (betiği --denetle olmadan çalıştırın).` : "Şablonlar güncel.");
  process.exitCode = stale.length ? 1 : 0;
} else {
  for (const [rel, buf] of files) {
    const full = path.join(OUT, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, buf);
  }
  console.log(`${TEMPLATES.length} şablon yazıldı: ${path.relative(ROOT, OUT)}`);
}
