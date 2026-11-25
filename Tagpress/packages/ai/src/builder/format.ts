import { BUILDER_LOOP, type Enforcement, PROFILE_DOCS, PROFILE_GROUPS, type ProfileRecord, type ProposeChangesResult, ProfileSchema } from "@tagpress/domain";
import { z } from "zod";

/**
 * Saf biçimleyiciler: profil, şema alanları, referans örnekleri ve motor denemesi okunur metne çevrilir.
 * İki kullanıcısı var: Claude Code'un MCP sunucusu (`apps/mcp`, sahibin yolu) ve sitedeki oluşturucu döngüsü
 * (araç sonuçları). İlk dört biçimleyici `apps/mcp/src/tools/*`'tan taşındı; çıktıları taşıma öncesiyle bayt bayt
 * aynıdır (`format.golden.json`, `format.test.ts`). Metinler Türkçedir: model de, sahip de aynı metni okur.
 */

/** Rozet: kim uygular. */
export const BADGE: Record<Enforcement, string> = {
  motor: "motor (kesin)",
  ai: "ai (yol gösterir)",
  ikisi: "ai + motor denetimi",
  sistem: "sistem",
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Profil yaprakları: açıklaması olan yol bir yaprak sayılır (dizi/nesne olsa bile). */
export function profileLeaves(data: unknown, prefix = ""): Array<{ path: string; value: unknown }> {
  if (prefix && PROFILE_DOCS[prefix]) return [{ path: prefix, value: data }];
  if (isObj(data)) return Object.entries(data).flatMap(([k, v]) => profileLeaves(v, prefix ? `${prefix}.${k}` : k));
  return prefix && prefix !== "schemaVersion" ? [{ path: prefix, value: data }] : [];
}

const show = (v: unknown) => (typeof v === "string" ? (v.includes("\n") || v.length > 80 ? `\n${v}` : JSON.stringify(v)) : JSON.stringify(v));

/** Profili gruplara göre, alan açıklamaları ve rozetlerle okunur metne çevirir. */
export function formatProfile(rec: ProfileRecord, group?: string): string {
  const leaves = profileLeaves(rec.data);
  const out: string[] = [];
  for (const g of PROFILE_GROUPS) {
    if (group && g.id !== group) continue;
    const rows = leaves.filter((l) => PROFILE_DOCS[l.path]?.group === g.id);
    if (!rows.length) continue;
    out.push(`\n## ${g.label} (${g.id}) — ${g.help}`);
    for (const r of rows) {
      const d = PROFILE_DOCS[r.path]!;
      out.push(`- ${r.path} = ${show(r.value)}\n  ${d.label} · [${BADGE[d.enforcement]}]${d.unit ? ` · birim: ${d.unit}` : ""} — ${d.help}`);
    }
  }
  const undocumented = leaves.filter((l) => !PROFILE_DOCS[l.path]);
  if (undocumented.length && !group) out.push(`\n## Açıklamasız alanlar\n${undocumented.map((l) => `- ${l.path} = ${show(l.value)}`).join("\n")}`);
  return out.join("\n");
}

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  additionalProperties?: SchemaNode | boolean;
}

/** Yazılabilir alanlar: yol, tür, sınırlar, varsayılan + açıklama ve rozet (profil şemasından türetilir). */
export function schemaFields(): Array<Record<string, unknown>> {
  const root = z.toJSONSchema(ProfileSchema, { io: "input", unrepresentable: "any" }) as SchemaNode;
  const out: Array<Record<string, unknown>> = [];
  const typeOf = (n: SchemaNode): string => {
    if (n.enum) return `seçenek: ${n.enum.map((x) => JSON.stringify(x)).join(" | ")}`;
    const alts = n.anyOf ?? n.oneOf;
    if (alts) return alts.map(typeOf).join(" | ");
    if (n.type === "array") return `dizi<${n.items ? typeOf(n.items) : "?"}>`;
    if (n.type === "object" && n.properties) return `nesne{${Object.keys(n.properties).join(", ")}}`;
    if (n.type === "object" && isObj(n.additionalProperties)) return `sözlük<metin → ${typeOf(n.additionalProperties as SchemaNode)}>`;
    return Array.isArray(n.type) ? n.type.join(" | ") : (n.type ?? "?");
  };
  const walk = (n: SchemaNode, path: string) => {
    const doc = PROFILE_DOCS[path];
    if (path && (doc || !n.properties)) {
      if (path === "schemaVersion") return;
      out.push({
        path,
        type: typeOf(n),
        ...(n.minimum !== undefined ? { min: n.minimum } : {}),
        ...(n.exclusiveMinimum !== undefined ? { minExclusive: n.exclusiveMinimum } : {}),
        ...(n.maximum !== undefined ? { max: n.maximum } : {}),
        ...(n.default !== undefined && !isObj(n.default) ? { default: n.default } : {}),
        ...(doc ? { label: doc.label, enforcement: BADGE[doc.enforcement], group: doc.group, level: doc.level, ...(doc.unit ? { unit: doc.unit } : {}), help: doc.help } : {}),
      });
      return;
    }
    for (const [k, v] of Object.entries(n.properties ?? {})) walk(v, path ? `${path}.${k}` : k);
  };
  walk(root, "");
  return out;
}

/** Referans örneğinin biçimlenen hâli (`GET …/learn/samples` yanıtındaki öğe). */
export interface ReferenceSampleView {
  id: string;
  text: string;
  templateKey: string | null;
  split: string;
  orderNo: string | null;
  labelFramePx: number;
  lines: Array<{ text: string; font: string; sizePx: number; pt: number; segments: Array<{ text: string; font: string; sizePx: number }> }>;
  program: string[] | null;
  imageUrl: string | null;
}

export function formatSample(s: ReferenceSampleView, i: number): string {
  const lines = s.lines
    .map((l) => `   │ ${l.text}   [${l.font} · ${l.pt} pt / ${l.sizePx} px${l.segments.length ? ` · özel: ${l.segments.map((x) => `"${x.text}" ${x.font} ${x.sizePx}px`).join(", ")}` : ""}]`)
    .join("\n");
  const prog = s.program && s.program.join(" / ") !== s.lines.map((l) => l.text).join(" / ") ? `\n   Programın önerisi: ${s.program.join(" / ")}` : "";
  return `${i + 1}. ${s.id} · şablon ${s.templateKey ?? "—"} · ${s.split}${s.labelFramePx !== 440 ? ` · frame ${s.labelFramePx}px` : ""}\n   Müşteri metni: ${JSON.stringify(s.text)}\n   Kullanıcının satırları:\n${lines}${prog}`;
}

const fmtN = (x: unknown, d = 3) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "—");

/** Motor denemesinin bir yüzü (taslak ya da yayınlanan profil). */
export interface ReplaySideView {
  label: string;
  metrics: Record<string, number | null>;
  worst: Array<{ id: string; templateKey: string | null; ok: boolean; reason: string | null; sizeRatio: number; dx: number; dy: number }>;
  summary: { gaps: Record<string, { n: number; user: number; engine: number }> };
}

export function formatReplay(r: { refs: number; split: string; sides: ReplaySideView[] }): string {
  const out = [`${r.refs} referans (${r.split === "test" ? "ayrılmış küme" : r.split === "train" ? "öğrenme kümesi" : "hepsi"}), kullanıcının kendi satırları motora verildi (AI yok, ücretsiz).`];
  for (const s of r.sides) {
    const m = s.metrics;
    out.push(
      `\n## ${s.label}`,
      `- en büyük satır ±%10 içinde: ${m.within10}/${m.n}${m.failed ? ` (yerleşmeyen ${m.failed})` : ""}`,
      `- boyut motor/kullanıcı ortanca: ${fmtN(m.sizeRatio)} · sapma ortanca ${fmtN(m.sizeError)}`,
      `- blok yüksekliği sapması: ${fmtN(m.heightError)} · blok merkezi uzaklığı ${fmtN(m.positionError, 1)} px (dx ${fmtN(m.dx, 1)}, dy ${fmtN(m.dy, 1)})`,
      `- boşluk farkı (|motor − kullanıcı|, em): satır arası ${fmtN(m.gapNormal)} · son satır öncesi ${fmtN(m.gapBeforeLast)} · bağlaç ${fmtN(m.gapConnector)}`,
    );
    for (const [k, g] of Object.entries(s.summary.gaps ?? {})) out.push(`  · ${k}: kullanıcı ortanca ${fmtN(g.user, 2)} · motor ${fmtN(g.engine, 2)} (n=${g.n}; yaklaşık satırlar dahil)`);
    if (s.worst.length) out.push(`- en uzak etiketler: ${s.worst.map((w) => `${w.id} (şablon ${w.templateKey ?? "—"}, ${w.ok ? `boyut ×${fmtN(w.sizeRatio, 2)}` : `yerleşmedi: ${w.reason}`})`).join("; ")}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- oluşturucu araç sonuçları (modelin okuyacağı metin)

/**
 * `propose_changes` sonucunu modele metin olarak verir. Kabul edilenler, reddedilenler (kod + parametre; model
 * düzeltip yeniden önerir) ve üst üste başarısızlık sayısı. Hiçbiri kabul edilmediyse araç sonucu `is_error` olur
 * (bunu döngü belirler: `rev === null`).
 */
export function formatProposalResult(r: ProposeChangesResult): string {
  const out: string[] = [];
  out.push(r.rev === null ? "No change was applied; the draft is unchanged." : `Revision ${r.rev} written (${r.applied.length} change${r.applied.length === 1 ? "" : "s"} applied).`);
  for (const c of r.applied) {
    const warn = c.warning ? ` · WARNING ${c.warning.code}${c.warning.params ? ` ${JSON.stringify(c.warning.params)}` : ""}` : "";
    out.push(`- applied ${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)} (source ${c.source.kind}${c.source.ref ? ` ${c.source.ref}` : ""}${c.source.n !== undefined ? `, n=${c.source.n}` : ""})${warn}`);
  }
  for (const x of r.rejected) out.push(`- REJECTED changes[${x.index}] ${x.path}: ${x.code}${x.params ? ` ${JSON.stringify(x.params)}` : ""}`);
  if (r.rejected.length) {
    out.push(
      `Fix only the rejected changes and propose them again. Consecutive failed proposals: ${r.failedStreak}/${BUILDER_LOOP.maxFailedProposals}; at the limit the turn ends and the user is told which fields could not be written.`,
    );
  }
  return out.join("\n");
}

/** Ham metni bu kadar karakterden uzunsa kesilir (bağlamı şişirmesin; model girdiyi baştan yazar). */
const INVALID_JSON_MAX_CHARS = 8000;

/**
 * Girdisi katı JSON olmayan araç çağrısının sonucu (Anthropic'in belgelediği biçim: `{"INVALID_JSON": "<ham metin>"}`,
 * JSON kitaplığıyla kurulur ki ham metindeki tırnaklar kaçışlansın).
 */
export function formatInvalidToolJson(raw: string): string {
  return JSON.stringify({ INVALID_JSON: raw.length > INVALID_JSON_MAX_CHARS ? `${raw.slice(0, INVALID_JSON_MAX_CHARS)}…` : raw });
}

/** Doğrulamayı geçemeyen araç girdisi: aracı çalıştırmadan modele dönen hata metni (alan yollarıyla). */
export function formatToolInputError(name: string, issues: readonly string[]): string {
  return [`The input for ${name} was rejected before running the tool:`, ...issues.map((i) => `- ${i}`), "Correct the input and call the tool again."].join("\n");
}
