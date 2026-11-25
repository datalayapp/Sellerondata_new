/**
 * Benzer örnekler: kullanıcının geçmişte bitirdiği etiketlerden, yeni müşteri metnine en çok benzeyenlerin
 * satır bölmelerini AI'a göstermek için. Tarz koda gömülmez: örnekler kullanıcının kendi verisidir
 * (referansların öğrenme kümesi). Kabul ölçümünde ayrılmış küme ASLA havuza girmez.
 */

export interface BreakExample {
  /** Müşteri metni. */
  text: string;
  /** Kullanıcının bölmesi, müşteri metninin karakterleriyle (bkz. `breaksOnCustomerText`). */
  lines: string[];
  /** Kaynak referans (varsa; ölçümde referansın kendisini havuzdan çıkarmak için). */
  referenceId?: string;
  /** Örneğin bittiği şablon (varsa): aynı şablondaki alışkanlık daha güçlü kanıttır. */
  templateKey?: string | null;
  /** `pickSimilarExamples` doldurur: bu işle aynı şablonda mı? */
  sameTemplate?: boolean;
  /**
   * `pickSimilarExamples` doldurur (yalnızca şablon verildiğinde ve true ise): metnin kaba yapısı bu işinkiyle aynı
   * (ör. ikisi de "isim bağlaç isim tarih"). Aynı şablondaysa en güçlü alışkanlık kanıtıdır.
   */
  sameStructure?: boolean;
  /**
   * Örneğin bittiği şablonun serbest yazı alanı en/boy oranı (piksel değil; sunucu doldurur, bilinmiyorsa yok).
   * Alana bağlı alışkanlıklarda (ör. çift dizilişi) AI benzer biçimli alanlardaki örnekleri ayırt edebilsin diye.
   */
  areaAspect?: number;
}

const SEPARATOR_ONLY = /^[\s\-–—,~•·.!|/]+$/u;
const DATE = /^\d{1,4}([./\-~]\d{1,4}){1,2}$/u;

const words = (t: string) => t.split(/\s+/u).filter(Boolean);
const bare = (w: string) => w.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}&+]/gu, "");

/**
 * Kullanıcının bitmiş etiketteki (referans) satırlarını müşteri metnine uygular: kelime sayıları sırayla eşlenir.
 * Kullanıcı satır sonundaki ayırıcıları sildiği için örnek, müşteri metninin kendisiyle yazılır
 * (AI'a karakter değiştirmeyi öğretmemek için). Kelimeler uyuşmazsa (kullanıcı metni değiştirmiş) null.
 *
 * Kullanıcı bir sembolü (ör. "&") tek başına kelime yazmış ama müşteri metninde sembol kelimeye yapışıksa
 * ("Daniel&Ruby" → "Daniel" / "&" / "Ruby"), müşteri kelimesi o sembolden bölünür; satır içinde yapışık parçalar
 * yine boşluksuz yazılır (metin değişmez). Sembol listesi kodda değil, kullanıcının satırlarındadır.
 */
export function breaksOnCustomerText(customerText: string, userLines: readonly string[]): string[] | null {
  const userWords = userLines.flatMap(words);
  const symbols = [...new Set(userWords.filter((w) => !/[\p{L}\p{N}]/u.test(w) && !SEPARATOR_ONLY.test(w)))];
  const split = (w: string): Array<{ w: string; glue: boolean }> => {
    let parts = [w];
    for (const s of symbols) parts = parts.flatMap((p) => p.split(s).flatMap((x, i) => (i ? [s, x] : [x])));
    return parts.filter(Boolean).map((p, i) => ({ w: p, glue: i > 0 }));
  };
  const cw = words(customerText).flatMap(split);
  const groups = userLines.map((l) => words(l).flatMap((w) => split(w).map((p) => p.w)).filter((w) => !SEPARATOR_ONLY.test(w))).filter((g) => g.length);
  const cwReal = cw.filter((t) => !SEPARATOR_ONLY.test(t.w));
  if (groups.flat().length !== cwReal.length) return null;
  const flat = groups.flat();
  for (let i = 0; i < flat.length; i++) if (bare(flat[i]!) !== bare(cwReal[i]!.w)) return null;
  const out: string[] = [];
  let k = 0;
  const join = (ts: ReadonlyArray<{ w: string; glue: boolean }>) => ts.map((t, i) => (i && !t.glue ? ` ${t.w}` : t.w)).join("");
  for (const g of groups) {
    const line: Array<{ w: string; glue: boolean }> = [];
    let need = g.length;
    while (need > 0 && k < cw.length) {
      const t = cw[k++]!;
      line.push(t);
      if (!SEPARATOR_ONLY.test(t.w)) need--;
    }
    // Ayırıcı yalnız kelime (ör. "-") bir sonraki satırın başına değil, bu satırın sonuna yapışık kalır.
    while (k < cw.length && SEPARATOR_ONLY.test(cw[k]!.w)) line.push(cw[k++]!);
    out.push(join(line));
  }
  return out.length ? out : null;
}

/**
 * Sembol bağlaçların (&, +) çevresine boşluk: "Daniel&Ruby" ile "Anna & Marco" aynı yapıdadır. Yalnızca imza ve
 * kelime örtüşmesi için; örneğin AI'a giden metni değişmez. Semboller profilden gelir.
 */
function spaceSymbols(text: string, connectors: ReadonlySet<string>): string {
  let out = text;
  for (const c of connectors) if (c && !/[\p{L}\p{N}]/u.test(c)) out = out.split(c).join(` ${c} `);
  return out;
}

/** Metnin yapı imzası: N = büyük harfle başlayan kelime, C = bağlaç, D = tarih/sayı, w = diğer. */
function signature(text: string, connectors: ReadonlySet<string>): string {
  return words(spaceSymbols(text, connectors))
    .map((w) => {
      const b = bare(w);
      if (connectors.has(b) || connectors.has(w)) return "C";
      if (DATE.test(w) || /^\d+$/.test(b)) return "D";
      if (/^\p{Lu}/u.test(w)) return "N";
      return "w";
    })
    .join("")
    .replace(/w+/g, "w")
    .replace(/N{3,}/g, "NN");
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** İki imza arasındaki benzerlik (0..1): ortak önek + uzunluk farkı. */
function sigSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return (p / Math.max(a.length, b.length)) * 0.8;
}

/** Aynı şablonda aynı yapıdaki örneklerden en çok bu kadarı, çeşitlilik sınırına takılmadan başa alınır. */
const MAX_ANCHORS = 3;

/**
 * Kaba yapı: ardışık isimler ve sayılar tek sayılır ("Yuriy & Ana Isabel 27.10.2026" ile "Hannia & Erin 10.24.2026"
 * aynı: N C N D). Yalnızca bağlaç VE tarih/sayı içeren yapılar çapa olur: ölçümde (öğrenme kümesi, birini dışarıda
 * bırakarak) şablon alışkanlığı yalnızca "iki isim + tarih"te kazandırdı (12/15, genel çoğunluk 9/15); yalnız çiftte
 * kaybettirdi (3/5, genel 4/5). Kod kelime bilmez: bağlaçlar profilden gelir.
 */
function anchorStructure(sig: string): string | null {
  const c = coarse(sig);
  return c.includes("C") && c.includes("D") ? c : null;
}

function coarse(sig: string): string {
  return sig.replace(/N+/g, "N").replace(/D+/g, "D");
}

/**
 * En benzer `k` örnek. Puan: kelime örtüşmesi (dil ve kalıp: "Battesimo di", "Thank you for"), yapı imzası
 * (çift + tarih, uzun cümle + isim) ve uzunluk yakınlığı. Aynı bölme kalıbını tekrarlayan örneklerden biri yeter.
 *
 * Aynı şablonda AYNI yapıdaki örnekler (ör. bu şablondaki başka bir "isim & isim tarih") en güçlü alışkanlık
 * kanıtıdır: başa alınır ve işaretlenir. Ölçüldü (öğrenme kümesi, ölçülen referans havuz dışı): iki isim + tarih
 * çiftlerinde şablondaki çoğunluk kullanıcının dizilişini 12/15 tutturuyor, genel çoğunluk 9/15.
 */
export function pickSimilarExamples(
  text: string,
  pool: readonly BreakExample[],
  k = 6,
  connectors: readonly string[] = [],
  opts: { templateKey?: string | null } = {},
): BreakExample[] {
  const conn = new Set(connectors.map((c) => c.toLocaleLowerCase("tr")));
  const wordSet = (t: string) => new Set(words(spaceSymbols(t, conn)).map(bare).filter(Boolean));
  const tw = wordSet(text);
  const ts = signature(text, conn);
  const tAnchor = anchorStructure(ts);
  const tl = text.length;
  const scored = pool
    .filter((e) => e.text.trim() && e.text.trim() !== text.trim())
    .map((e) => {
      const es = signature(e.text, conn);
      const len = 1 - Math.min(1, Math.abs(e.text.length - tl) / Math.max(tl, e.text.length, 1));
      // Aynı şablon küçük bir artı: yapısı benzeyen örnekler arasında aynı şablondakini öne alır
      // (ör. bir çift bazı şablonlarda alt alta, bazılarında tek satır yazılıyor).
      const same = !!opts.templateKey && e.templateKey === opts.templateKey;
      const score = jaccard(tw, wordSet(e.text)) * 1.0 + sigSimilarity(ts, es) * 0.9 + len * 0.3 + (same ? 0.3 : 0);
      const sameStructure = tAnchor !== null && anchorStructure(es) === tAnchor;
      const e2 = opts.templateKey ? { ...e, sameTemplate: same, ...(sameStructure ? { sameStructure } : {}) } : e;
      return { e: e2, score, shape: `${es}|${e.lines.length}`, anchor: same && sameStructure };
    })
    .sort((a, b) => b.score - a.score);
  const anchors = scored.filter((s) => s.anchor).slice(0, Math.min(k, MAX_ANCHORS));
  const out: BreakExample[] = anchors.map((s) => s.e);
  const shapes = new Map<string, number>();
  for (const s of anchors) shapes.set(s.shape, (shapes.get(s.shape) ?? 0) + 1);
  for (const s of scored) {
    if (out.length >= k) break;
    if (anchors.includes(s)) continue;
    const n = shapes.get(s.shape) ?? 0;
    if (n >= 2) continue; // aynı kalıptan en fazla iki örnek: çeşitlilik
    shapes.set(s.shape, n + 1);
    out.push(s.e);
  }
  return out;
}

const aspectText = (a: number) => String(Math.round(a * 100) / 100);

/**
 * İstem bölümü: en benzer örnekler (profil örneklerinden ayrı, işe özel).
 *
 * `areaAspect` (bu işin şablonundaki serbest yazı alanının en/boy oranı) ve örneklerin `areaAspect`'i verilirse
 * her örneğe alan oranı yazılır. Eşik koda gömülmez: dar/geniş ayrımı profil notlarındadır (ör. çiftler);
 * istem yalnızca oranları yan yana koyar. Ölçüm: geniş alanlı şablonlarda çiftler, benzer örneklerin çoğunluğu
 * dar alanlarda alt alta olduğu için alt alta öneriliyordu ("Lidia & Chris" 1,53; "Dani i Carla" 1,93).
 */
export function similarExamplesSection(examples: readonly BreakExample[], opts: { areaAspect?: number } = {}): string {
  if (!examples.length) return "";
  const anchored = examples.some((e) => e.sameTemplate && e.sameStructure);
  const withArea = examples.some((e) => e.areaAspect !== undefined && Number.isFinite(e.areaAspect));
  const job = opts.areaAspect !== undefined && Number.isFinite(opts.areaAspect) ? opts.areaAspect : undefined;
  return [
    "## How this designer broke the most similar texts in past orders (strong evidence of their habit; follow the same pattern when the text has the same structure, but never copy their words)",
    anchored
      ? 'Texts marked "same template, same structure" are the strongest evidence: on this very template the designer broke a text built like this one that way, so the most likely design breaks the lines the same way (if they disagree, follow the majority).'
      : "",
    withArea
      ? `"area w/h" is the width/height of the free text area of the template each example was finished on${job !== undefined ? ` (this job's template: ${aspectText(job)})` : ""}. Where the designer's habit depends on the shape of the area (see the line-breaking notes), follow the examples whose area is shaped like this job's, not a majority made on differently shaped areas.`
      : "",
    ...examples.map((e) => {
      const tags = [
        e.sameTemplate ? (e.sameStructure ? "same template, same structure" : "on this same template") : "",
        e.areaAspect !== undefined && Number.isFinite(e.areaAspect) ? `area w/h ${aspectText(e.areaAspect)}` : "",
      ].filter(Boolean);
      return `- ${JSON.stringify(e.text)} → ${e.lines.map((l) => JSON.stringify(l)).join(" / ")}${tags.length ? ` (${tags.join("; ")})` : ""}`;
    }),
  ]
    .filter(Boolean)
    .join("\n");
}
