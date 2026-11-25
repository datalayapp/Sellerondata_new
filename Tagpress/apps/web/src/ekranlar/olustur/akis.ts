import {
  BUILD_MESSAGE_KINDS_BY_STATE,
  PROFILE_GROUPS,
  type BuildEntry,
  type BuildMessage,
  type BuildQuestion,
  type BuildState,
  type Profile,
  type ProfileGroup,
  type RuleChange,
  type ShowcaseItem,
} from "@tagpress/domain";

/**
 * Oluştur ekranının saf mantığı (birim testi `akis.test.ts`): akış girdilerinin birleştirilmesi, soldaki sohbetin
 * öğeleri, yazı kutusunun ileti türü, cevap gövdesi, örnek etiketlerin tuval yerleşimi ve sağdaki özetin satırları.
 * Görünen metin burada kurulmaz (sözlük bileşende); burada yalnız veri.
 */

// ================================================================ akış girdileri

/** Yeni girdileri eskilere ekler: kimliğe göre tekil, sıralı (SSE ile gelen soru ve sorguyla gelen liste çakışabilir). */
export function mergeEntries(old: readonly BuildEntry[], add: readonly BuildEntry[]): BuildEntry[] {
  if (add.length === 0) return old as BuildEntry[];
  const byId = new Map<number, BuildEntry>();
  for (const e of old) byId.set(e.id, e);
  for (const e of add) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export type ChatItem =
  | { kind: "ai"; id: number; text: string }
  | { kind: "question"; id: number; question: BuildQuestion; pending: boolean; picked: number | null }
  | { kind: "revision"; id: number; rev: number; text: string }
  | { kind: "me"; id: number; text: string; tag: "answer" | "correction" | "note" }
  | { kind: "sample-edit"; id: number; sampleId: string; fields: string[] }
  | { kind: "notice"; id: number; code: string; params: Record<string, string | number> }
  | { kind: "error"; id: number; code: string; params: Record<string, string | number> };

/**
 * Girdiler → sohbet öğeleri. Cevap girdisi kullanıcının balonu olur (seçenek adı ve/veya yazdığı); sorunun seçilen
 * seçeneği soruda da işaretlenir. `pending`: oturumun bekleyen soru kimlikleri (`Build.pendingQuestions`).
 */
export function chatItems(entries: readonly BuildEntry[], pending: ReadonlySet<string>): ChatItem[] {
  const questions = new Map<string, BuildQuestion>();
  const picked = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "question" && e.question) questions.set(e.question.id, e.question);
    if (e.kind === "answer" && e.answer && e.answer.option !== null) picked.set(e.answer.questionId, e.answer.option);
  }
  const out: ChatItem[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case "text":
        if (e.text?.trim()) out.push({ kind: "ai", id: e.id, text: e.text });
        break;
      case "question":
        if (e.question) out.push({ kind: "question", id: e.id, question: e.question, pending: pending.has(e.question.id), picked: picked.get(e.question.id) ?? null });
        break;
      case "revision":
        out.push({ kind: "revision", id: e.id, rev: e.rev ?? 0, text: e.text ?? "" });
        break;
      case "answer": {
        const a = e.answer;
        const q = a ? questions.get(a.questionId) : undefined;
        const label = a && a.option !== null ? (q?.options[a.option]?.label ?? null) : null;
        const text = [label, a?.text ?? null, a ? null : e.text].filter((s): s is string => !!s && !!s.trim()).join("\n");
        // Cevapsız metinli girdi (çoklu soruya serbest yazı) de kullanıcı balonudur.
        const shown = text || e.text || "";
        if (shown) out.push({ kind: "me", id: e.id, text: shown, tag: "answer" });
        break;
      }
      case "correction":
      case "note":
        if (e.text) out.push({ kind: "me", id: e.id, text: e.text, tag: e.kind });
        break;
      case "sample-edit":
        if (e.sampleEdit) out.push({ kind: "sample-edit", id: e.id, sampleId: e.sampleEdit.sampleId, fields: e.sampleEdit.fields });
        break;
      case "notice":
        out.push({ kind: "notice", id: e.id, code: e.code ?? "", params: e.params ?? {} });
        break;
      case "error":
        out.push({ kind: "error", id: e.id, code: e.code ?? "", params: e.params ?? {} });
        break;
    }
  }
  return out;
}

// ================================================================ yazı kutusu

export type ComposerKind = "answer" | "correction" | "note";

/** Yazı kutusunun gönderdiği ileti türü (sözleşmedeki izinli türlerden en anlamlısı); yazılamıyorsa null. */
export function composerKind(state: BuildState): ComposerKind | null {
  const kinds = BUILD_MESSAGE_KINDS_BY_STATE[state] ?? [];
  if (kinds.includes("answer")) return "answer";
  if (kinds.includes("correction")) return "correction";
  if (kinds.includes("note")) return "note";
  return null;
}

/**
 * Bekleyen sorulara cevap gövdesi. Seçilen hazır cevaplar soru başına bir cevap olur. Yazılan metin, tek bir soru
 * seçeneksiz kaldıysa (ve serbest cevap kabul ediyorsa) o sorunun cevabıdır; değilse iletinin genel metnidir.
 * Hiçbir şey yoksa null.
 */
export function answerBody(pending: readonly BuildQuestion[], picks: Readonly<Record<string, number>>, text: string): BuildMessage | null {
  const answers: Array<{ questionId: string; option?: number; text?: string }> = [];
  for (const q of pending) {
    const o = picks[q.id];
    if (o !== undefined && o >= 0 && o < q.options.length) answers.push({ questionId: q.id, option: o });
  }
  const v = text.trim();
  let rest: string | undefined = v || undefined;
  if (v) {
    const open = pending.filter((q) => picks[q.id] === undefined);
    if (open.length === 1 && open[0]!.free) {
      answers.push({ questionId: open[0]!.id, text: v });
      rest = undefined;
    }
  }
  if (answers.length === 0 && !rest) return null;
  return { kind: "answer", ...(answers.length ? { answers } : {}), ...(rest ? { text: rest } : {}) };
}

// ================================================================ örnek etiketlerin yerleşimi (mm)

/** Ölçüsü bilinmeyen örnek için kare (3,8 cm etiket). */
export const DEFAULT_LABEL_MM = 38;
const GAP_X = 24;
const TITLE_H = 10;
const BELOW_H = 16;
const GAP_Y = 10;

export interface ShowcaseBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Örnekleri `cols` sütunlu ızgaraya dizer; sütun genişliği ve satır yüksekliği en büyük örneğe göre. Dünya dikdörtgeni de döner. */
export function layoutShowcase(items: readonly Pick<ShowcaseItem, "id" | "sizeMm">[], cols = 3): { boxes: ShowcaseBox[]; world: { x: number; y: number; w: number; h: number } } {
  const dims = items.map((it) => ({ id: it.id, w: it.sizeMm?.w ?? DEFAULT_LABEL_MM, h: it.sizeMm?.h ?? DEFAULT_LABEL_MM }));
  const colW = Math.max(DEFAULT_LABEL_MM, ...dims.map((d) => d.w));
  const boxes: ShowcaseBox[] = [];
  let y = 0;
  for (let i = 0; i < dims.length; i += cols) {
    const row = dims.slice(i, i + cols);
    const rowH = Math.max(...row.map((d) => d.h));
    row.forEach((d, j) => boxes.push({ id: d.id, x: j * (colW + GAP_X) + (colW - d.w) / 2, y: y + (rowH - d.h) / 2, w: d.w, h: d.h }));
    y += rowH + TITLE_H + BELOW_H + GAP_Y;
  }
  const n = Math.min(cols, Math.max(1, dims.length));
  return { boxes, world: { x: 0, y: -TITLE_H, w: n * colW + (n - 1) * GAP_X, h: Math.max(DEFAULT_LABEL_MM, y - GAP_Y) + TITLE_H } };
}

// ================================================================ sağdaki özet

/**
 * Özette her grubun okunur birkaç kuralı (tarz değil, hangi alanların gösterileceği seçimi). Değişen ama listede olmayan
 * alan kendi grubunun sonuna eklenir.
 */
export const SUMMARY_PATHS: Partial<Record<ProfileGroup, string[]>> = {
  fontlar: ["fonts.list", "fonts.mixing"],
  boyut: ["sizing.fill", "sizing.tiers.secondary", "sizing.tiers.tertiary", "sizing.tiers.connector"],
  bosluk: ["spacing.align", "spacing.inkGaps.normal"],
  baglaclar: ["connectors.words", "connectors.separateDangling"],
  "satir-bolme": ["lineBreaking.coupleStack", "lineBreaking.maxLineChars"],
  "kalinlik-renk": ["weight.mode", "weight.widthEm", "color.text"],
};

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export interface SummaryRow {
  path: string;
  value: unknown;
  change: RuleChange | null;
}
export interface SummaryGroup {
  group: ProfileGroup;
  rows: SummaryRow[];
}

/** Profil + değişen kurallar → gruplu özet satırları (gruplar `PROFILE_GROUPS` sırasında; boş grup yok). */
export function summaryGroups(profile: Profile | null | undefined, changes: readonly RuleChange[]): SummaryGroup[] {
  const out: SummaryGroup[] = [];
  for (const g of PROFILE_GROUPS) {
    const rows: SummaryRow[] = [];
    const seen = new Set<string>();
    for (const p of SUMMARY_PATHS[g.id] ?? []) {
      const value = profile ? getPath(profile, p) : undefined;
      const change = changes.find((c) => c.path === p) ?? null;
      if (value === undefined && !change) continue;
      rows.push({ path: p, value: change ? change.to : value, change });
      seen.add(p);
    }
    for (const c of changes) {
      if (c.group !== g.id || seen.has(c.path)) continue;
      rows.push({ path: c.path, value: c.to, change: c });
      seen.add(c.path);
    }
    if (rows.length) out.push({ group: g.id, rows });
  }
  return out;
}
