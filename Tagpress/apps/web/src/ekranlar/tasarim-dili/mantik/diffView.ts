import { PROFILE_DOCS, type FieldDoc } from "@tagpress/domain";
import { num, pct, tt } from "../dil.ts";
import { fieldLabel } from "../profilMetni.ts";
import { ENUMS, unitSuffix } from "./formSpec.ts";

/** İki profil arasındaki bir alan değişikliğini insan diliyle gösterir. Metinler `designLanguage:diff.*`. */

const SUB_KEYS = new Set(["kind", "cx", "cy", "r", "rx", "ry", "x", "y", "w", "h", "radius", "points"]);
/** Şekil alt alanının adı (ör. `r` → "yarıçap"); tanımsızsa anahtarın kendisi. */
const subKey = (k: string): string => (SUB_KEYS.has(k) ? tt(`designLanguage:diff.sub.${k}`) : k);
const d = (key: string, o?: Record<string, unknown>) => tt(`designLanguage:diff.${key}`, o);

/** Yola en uygun alan tanımı: tam eşleşme, yoksa en uzun üst yol. */
export function docFor(path: string): { doc: FieldDoc; path: string; rest: string } | null {
  const parts = path.split(".");
  for (let n = parts.length; n > 0; n--) {
    const key = parts.slice(0, n).join(".");
    const doc = PROFILE_DOCS[key];
    if (doc) return { doc, path: key, rest: parts.slice(n).join(".") };
  }
  return null;
}

export function labelFor(path: string): string {
  const hit = docFor(path);
  if (!hit) return path;
  const base = fieldLabel(hit.path);
  if (!hit.rest) return base;
  const sub = hit.rest
    .split(".")
    .map(subKey)
    .join(" · ");
  return `${base} · ${sub}`;
}

function asList(v: unknown[]): string {
  if (v.length === 0) return d("empty");
  if (v.every((x) => typeof x === "string" || typeof x === "number")) return v.join(", ");
  return v
    .map((x) => {
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        return String(o.label || o.frameName || o.family || o.text || o.id || "…");
      }
      return String(x);
    })
    .join(", ");
}

export function formatValue(path: string, v: unknown): string {
  if (v === null || v === undefined) return d("none");
  if (typeof v === "boolean") return v ? d("on") : d("off");
  const hit = docFor(path);
  const unit = hit && !hit.rest ? hit.doc.unit : undefined;
  if (typeof v === "number") {
    if (unit === "oran") return pct(v);
    return unit ? `${num(v, 3)} ${unitSuffix(unit)}` : num(v, 3);
  }
  if (typeof v === "string") {
    const label = ENUMS[path]?.find((o) => o.value === v)?.label;
    return label ?? (v === "" ? d("empty") : v);
  }
  if (Array.isArray(v)) {
    if (path === "lineBreaking.typicalLines" && v.length === 2) return d("lines", { min: v[0], max: v[1] });
    if (path === "lineBreaking.examples") return d("examples", { n: v.length });
    if (path === "glyphRules") return v.length ? d("rules", { n: v.length, list: asList(v) }) : d("noRules");
    return asList(v);
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, x]) => `${subKey(k)}: ${typeof x === "number" ? num(x, 3) : String(x)}`)
      .join(", ");
  }
  return String(v);
}

export interface ChangeView {
  path: string;
  label: string;
  group: string | null;
  from: string;
  to: string;
}

export function describeChange(c: { path: string; from: unknown; to: unknown }): ChangeView {
  const hit = docFor(c.path);
  return {
    path: c.path,
    label: labelFor(c.path),
    group: hit?.doc.group ?? null,
    from: formatValue(c.path, c.from),
    to: formatValue(c.path, c.to),
  };
}
