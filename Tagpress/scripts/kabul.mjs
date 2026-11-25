// Kabul ölçümü: ayrılmış test referanslarında gerçek Haiku 5.5 (deneme ucu; varyasyon oluşturmaz).
// Kullanım: node kabul.mjs <limit> [--kuru] [--train] [--offset N] [--json çıktı.json] [--kalip "çift"] [--profil draft] [--paralel 4]
// Deneme ucundan hata ayıklama alanı (`debug: true`) istenir: bütün adaylar ve sıralama. Ek ücret yok.
import { writeFileSync } from "node:fs";
import { tagpressEnv } from "../packages/domain/src/env.ts";

const B = tagpressEnv("URL") ?? "http://127.0.0.1:5420";
const H = { "content-type": "application/json", "X-Studio": "1" };
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const limit = Number(process.argv[2] ?? 10);
const offset = Number(arg("--offset") ?? 0);
const jsonOut = arg("--json");
const dry = process.argv.includes("--kuru");
const split = process.argv.includes("--train") ? "train" : "test";
const refs = (await (await fetch(`${B}/api/references?languageId=benim-tarzim&split=${split}`)).json()).references
  .filter((r) => r.labelFramePx === 440 && r.templateKey)
  .slice(offset, offset + limit);
// Satır karşılaştırması: boşluklar, satır başı optik boşlukları ve kullanıcının bitmiş etikette sildiği sondaki ayırıcılar yok sayılır.
const norm = (t) => t.replace(/\s+/g, " ").trim().replace(/[\s\-–,~•·.!]+$/u, "").toLowerCase();
// İkincil ölçü (yalnızca bilgi): kelime sınırları aynı mı — boşluk farkları ve satır başındaki/sonundaki ayırıcılar
// ("- Jain Family" / "Happy Diwali -") yok sayılır. Birincil ölçü (`sameBreaks`) HANDOFF'taki tanımla aynı kalır.
const bnorm = (t) => norm(t).replace(/^[\s\-–,~•·.!]+/u, "").replace(/\s+/gu, "");
const sameWordBreaks = (userLines, lines) => {
  const u = userLines.map(bnorm).filter(Boolean);
  const e = lines.map(bnorm).filter(Boolean);
  return u.length === e.length && u.every((t, k) => t === e[k]);
};
/** Sıralama özetindeki "[modelin ilk seçimi: a / b]" (sunucu yazar; yalnızca model 1. adaydan farklı seçtiyse). */
const modelChoice = (summary) => /\[modelin ilk seçimi: (.*)\]$/u.exec(summary ?? "")?.[1] ?? null;
const sameBreaks = (u, lines) => {
  const e = lines.map(norm).filter(Boolean);
  return u.length === e.length && u.every((t, k) => t === e[k]);
};

/**
 * Hata kalıbı (yalnızca ölçüm kırılımı için; üretimi etkilemez). Bir metin birden çok kalıba girebilir.
 * çift: iki ad bir bağlaçla · edat: di/de/of… · kısa selam: ≤3 kelime selam/teşekkür · uzun cümle: ≥6 kelime.
 */
const GREETING = /^(¡?thank|thanks|grazie|¡?gracias|merci|danke|happy|merry|frohe|buon|feliz|joyeux|welcome|benvenut|love|enjoy|god bless|amor|viva|congrat)/iu;
const PREP = /\s(di|de|del|della|of|per|por|la|il)\s/iu;
const COUPLE = /\p{Lu}[\p{L}'’]*\s*(&|\+|\s(and|e|et|und|y|i|en|ve)\s)\s*\p{Lu}/u;
function patterns(text) {
  const words = text.trim().split(/\s+/u);
  const out = [];
  if (COUPLE.test(text)) out.push("çift");
  if (PREP.test(` ${text} `)) out.push("edat");
  if (words.length <= 3 && GREETING.test(text.trim())) out.push("kısa selam");
  if (words.length >= 6) out.push("uzun cümle");
  if (!out.length) out.push("diğer");
  return out;
}

// İsteğe bağlı: yalnızca bir hata kalıbı (--kalip "kısa selam") ve taslak profil (--profil draft; öneri ölçümü).
const onlyPattern = arg("--kalip");
const which = arg("--profil") === "draft" ? "draft" : "published";
if (onlyPattern) refs.splice(0, refs.length, ...refs.filter((r) => patterns(r.text).includes(onlyPattern)));
const samples = refs.map((r) => ({ id: r.id, text: r.text, templateKey: r.templateKey, referenceId: r.id }));
let totalCost = 0, same = 0, within = 0, n = 0, fails = 0;
let firstSame = 0, anySame = 0, rankLost = 0, fontSame = 0, withDebug = 0, wordSame = 0;
const byPattern = {};
const rows = [];
// Parçalar (5'er örnek) aynı anda en fazla PARALLEL istekle gönderilir; sonuçlar sırayla işlenir.
const CHUNK = 5;
const PARALLEL = Number(arg("--paralel") ?? 4);
const chunks = [];
for (let i = 0; i < samples.length; i += CHUNK) chunks.push(samples.slice(i, i + CHUNK));
const post = async (chunk) => {
  const res = await fetch(`${B}/api/languages/benim-tarzim/profile/try`, { method: "POST", headers: H, body: JSON.stringify({ samples: chunk, profiles: [which], mode: "ai", dryRun: dry, debug: true }) });
  return { ok: res.ok, status: res.status, j: await res.json() };
};
if (dry) {
  const { j } = await post(chunks[0]);
  console.log(`tahmini maliyet (${chunks[0].length} örnek):`, j.estimateUsd, `· toplam ${samples.length} örnek ≈ $${((j.estimateUsd * samples.length) / chunks[0].length).toFixed(3)}`);
}
// Kuru koşuda hiçbir parça gönderilmez (process.exit Windows'ta açık bağlantıyla çöküyor).
const toRun = dry ? [] : chunks;
const answers = new Array(toRun.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(PARALLEL, toRun.length) }, async () => {
    while (next < toRun.length) {
      const k = next++;
      answers[k] = await post(toRun[k]).catch((err) => ({ ok: false, status: 0, j: { error: String(err) } }));
      console.log(`parça ${k + 1}/${toRun.length} bitti`);
    }
  }),
);
for (const [ci, a] of answers.entries()) {
  const i = ci * CHUNK;
  const j = a.j;
  if (!a.ok) { console.log("HATA", a.status, JSON.stringify(j).slice(0, 300)); continue; }
  totalCost += j.costUsd ?? 0;
  for (const r of j.results) {
    const ref = refs.find((x) => x.id === r.sampleId);
    const p = r[which];
    if (!p) { fails++; rows.push({ id: r.sampleId, hata: r.error }); continue; }
    n++;
    const u = ref.user.map((l) => norm(l.text)).filter(Boolean);
    const sb = sameBreaks(u, p.lines);
    const uMax = Math.max(...ref.user.map((l) => l.sizePx)), eMax = Math.max(...p.sizesPx);
    const ratio = eMax / uMax;
    if (sb) same++;
    if (sameWordBreaks(ref.user.map((l) => l.text), p.lines)) wordSame++;
    if (Math.abs(ratio - 1) <= 0.1) within++;
    const d = p.debug;
    const userFamilies = [...new Set(ref.user.map((l) => l.family))];
    const chosenFonts = d ? [...new Set(d.candidates[d.chosen].fonts.map((f) => f.split("/")[0]))] : [];
    const fontOk = d ? chosenFonts.every((f) => userFamilies.includes(f)) : null;
    let first = null, any = null, lost = null;
    if (d) {
      withDebug++;
      first = sameBreaks(u, d.candidates[0].lines);
      any = d.candidates.some((c) => sameBreaks(u, c.lines));
      lost = !sb && d.candidates.some((c) => c.placed && sameBreaks(u, c.lines));
      if (first) firstSame++;
      if (any) anySame++;
      if (lost) rankLost++;
      if (fontOk) fontSame++;
    }
    for (const pat of patterns(ref.text)) {
      const b = (byPattern[pat] ??= { n: 0, same: 0, first: 0, any: 0, lost: 0 });
      b.n++;
      if (sb) b.same++;
      if (first) b.first++;
      if (any) b.any++;
      if (lost) b.lost++;
    }
    rows.push({
      id: ref.orderNo,
      sablon: ref.templateKey,
      kalip: patterns(ref.text).join("+"),
      ayni: sb,
      birinci: first,
      herhangi: any,
      siralamaEledi: lost,
      fontAyni: fontOk,
      oran: Math.round(ratio * 100) / 100,
      kullanici: u.join(" / "),
      program: p.lines.map(norm).filter(Boolean).join(" / "),
      ...(d
        ? {
            adaylar: d.candidates.map((c, k) => `${k}${c.placed ? "" : "×"} ${c.lines.join(" / ")} [${[...new Set(c.fonts.map((f) => f.split("/")[0]))].join(",")}] puan ${c.score ?? "-"}`),
            sira: d.ranking,
            secilen: d.chosen,
            gerekce: d.reasons[d.chosen],
            ozet: d.rankSummary ?? "",
            // Teşhis: 1. aday korunduğunda modelin kendi ilk seçimi (özetin sonunda) kullanıcınınki mi?
            modelSecimi: modelChoice(d.rankSummary),
            modelSecimiAyni: modelChoice(d.rankSummary) ? sameBreaks(u, modelChoice(d.rankSummary).split(" / ")) : null,
          }
        : {}),
    });
  }
  console.log(`${Math.min(i + CHUNK, samples.length)}/${samples.length} · maliyet $${totalCost.toFixed(4)}`);
}
if (!dry) {
  for (const r of rows) console.log(JSON.stringify(r));
  const pc = (a, b) => `${a}/${b} (%${b ? Math.round((100 * a) / b) : 0})`;
  console.log(`\nSONUÇ (${split}, ${offset}..${offset + samples.length}): ${n} yerleşti, ${fails} başarısız · satır bölmesi aynı ${pc(same, n)} · boyut ±%10 ${pc(within, n)} · toplam $${totalCost.toFixed(4)}`);
  console.log(`İKİNCİL: kelime sınırları aynı (boşluk ve satır başı/sonu ayırıcıları yok sayılarak) ${pc(wordSame, n)}`);
  if (withDebug) {
    console.log(`TEŞHİS: seçilen = kullanıcı ${pc(same, n)} · 1. aday = kullanıcı ${pc(firstSame, withDebug)} · herhangi aday = kullanıcı ${pc(anySame, withDebug)} · sıralama kullanıcınınkini eledi ${pc(rankLost, withDebug)} · font ailesi aynı ${pc(fontSame, withDebug)}`);
    const differ = rows.filter((r) => r.modelSecimi);
    if (differ.length) {
      const gain = differ.filter((r) => r.modelSecimiAyni && !r.ayni).length;
      const loss = differ.filter((r) => !r.modelSecimiAyni && r.ayni).length;
      console.log(`TEŞHİS (sıralama): model ${differ.length} işte 1. adaydan farklısını seçerdi · modele güvenilseydi +${gain} / −${loss} satır bölmesi`);
    }
    for (const [k, b] of Object.entries(byPattern)) console.log(`  ${k.padEnd(11)} n=${b.n} · seçilen ${pc(b.same, b.n)} · 1. aday ${pc(b.first, b.n)} · herhangi ${pc(b.any, b.n)} · sıralama eledi ${b.lost}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ split, offset, n, same, within, totalCost, rows }, null, 1));
}
