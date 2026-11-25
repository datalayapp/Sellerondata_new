import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES, FIX_LABELS, ISSUE_MESSAGES, UNDO_MESSAGES } from "@tagpress/domain";
import { resources } from "./index.ts";

/**
 * Sözlük eşliği ve kapsamı: her ad alanı TR ve EN'de aynı anahtarlarla, boş değer ve yasak sözcük yok; Tezgâh
 * kodunda (bütün src) kullanılmayan anahtar yok. Kodda kalan Türkçe ve
 * eksik anahtar `pnpm --filter @tagpress/web check:i18n --strict` ile denetlenir.
 */
type Tree = Record<string, unknown>;
const PLURAL = /_(zero|one|two|few|many|other)$/;
const flat = (o: Tree, p = ""): Array<[string, unknown]> => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v as Tree, `${p}${k}.`) : [[`${p}${k}`, v] as [string, unknown]]));

const tr = resources.tr as Record<string, Tree>;
const en = resources.en as Record<string, Tree>;

/** Kod kaynağı: src altındaki .ts/.tsx (sözlük dosyaları hariç, testler dahil değil). */
function ancestors(key: string): string[] {
  const parts = key.split(".");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("."));
}

function corpus(): string {
  const roots = [new URL("../", import.meta.url)];
  const out: string[] = [];
  const walk = (u: URL) => {
    for (const name of readdirSync(u)) {
      const child = new URL(name, u);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, u));
      else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(readFileSync(child, "utf8"));
    }
  };
  for (const r of roots) walk(r);
  return out.join("\n");
}

describe("sözlükler", () => {
  it("TR ve EN aynı ad alanlarını taşır", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(tr).sort());
  });

  it.each(Object.keys(tr))("%s: TR ve EN anahtarları aynı, değer boş değil", (ns) => {
    const a = flat(tr[ns]!);
    const b = flat(en[ns] ?? {});
    expect(b.map(([k]) => k).sort()).toEqual(a.map(([k]) => k).sort());
    for (const [k, v] of [...a, ...b]) expect(typeof v === "string" && v.trim() !== "", `${ns}:${k}`).toBe(true);
  });

  it("yasak sözcük yok ('işçi' denmez, 'çalışan' yazılır)", () => {
    for (const lng of [tr, en]) for (const [ns, tree] of Object.entries(lng)) for (const [k, v] of flat(tree)) expect(/işçi|isçi|\bworkers?\b/i.test(String(v)), `${ns}:${k}`).toBe(false);
  });

  it("her anahtar Tezgâh kodunda kullanılıyor", () => {
    const code = corpus();
    const unused: string[] = [];
    for (const [ns, tree] of Object.entries(tr)) {
      for (const [k] of flat(tree)) {
        const key = k.replace(PLURAL, "");
        const used =
          code.includes(`${ns}:${key}`) ||
          new RegExp(`["'\`]${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(code) ||
          // Dinamik anahtar ailesi: herhangi bir üst düzey önek kodda `önek.${…}` biçiminde geçiyorsa (ör. `enums.${yol}.${değer}`).
          ancestors(key).some((a) => code.includes(`${a}.\${`) || code.includes(`${ns}:${a}.\${`));
        // profile:fields.* ve profile:groups.* alan yolundan dinamik okunur; kapsamını ekranlar/tasarim-dili/profil.test.ts denetler.
        const dynamic =
          (ns === "profile" && /^(fields|groups)\./.test(key)) ||
          // Sunucu kodları (errors, issues, issues:fix, common:undo) koddan değil sunucu yanıtından okunur (`i18n/sunucu.ts`);
          // kapsamını aşağıdaki "sunucu kodları" testi denetler.
          ns === "errors" ||
          ns === "issues" ||
          (ns === "common" && key.startsWith("undo."));
        if (!used && !dynamic) unused.push(`${ns}:${key}`);
      }
    }
    expect(unused).toEqual([]);
  });
});

/**
 * Sunucu kodları: `@tagpress/domain` messages.ts'teki her hata kodu, sorun cümlesi, düzeltme adı ve geri al kodu TR ve
 * EN sözlükte var (çoğullu kodlarda `_one` ve `_other`); TR metin sunucunun bugünkü cümlesiyle aynı; EN aynı
 * parametreleri kullanır. Sözlükte koda karşılığı olmayan (sunucuda bulunmayan) anahtar da yok.
 */
describe("sunucu kodları", () => {
  const families: Array<{ name: string; ns: string; prefix: string; table: Record<string, { tr: string }>; extra: string[] }> = [
    { name: "hata", ns: "errors", prefix: "", table: ERROR_MESSAGES, extra: ["generic"] },
    { name: "sorun", ns: "issues", prefix: "", table: ISSUE_MESSAGES, extra: [] },
    { name: "düzeltme", ns: "issues", prefix: "fix.", table: FIX_LABELS, extra: [] },
    { name: "geri al", ns: "common", prefix: "undo.", table: UNDO_MESSAGES, extra: ["generic"] },
  ];
  const lookup = (tree: Tree, key: string): string[] => {
    const all = new Map(flat(tree).map(([k, v]) => [k, String(v)]));
    const one = all.get(key);
    if (one !== undefined) return [one];
    return [all.get(`${key}_one`), all.get(`${key}_other`)].filter((v): v is string => v !== undefined);
  };
  const names = (s: string) => [...s.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]!);
  const domainNames = (s: string) => [...s.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]!);

  it.each(families)("$name: her kodun TR ve EN anahtarı var, TR metin sunucunun cümlesi, parametreler aynı", ({ ns, prefix, table }) => {
    const problems: string[] = [];
    for (const [code, def] of Object.entries(table)) {
      const key = `${prefix}${code}`;
      const trs = lookup(tr[ns]!, key);
      const ens = lookup(en[ns]!, key);
      if (!trs.length) problems.push(`tr eksik ${ns}:${key}`);
      if (!ens.length) problems.push(`en eksik ${ns}:${key}`);
      const want = def.tr.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, "{{$1}}");
      if (trs.length && !trs.includes(want)) problems.push(`tr farklı ${ns}:${key}: ${trs[0]} ≠ ${want}`);
      const params = new Set(domainNames(def.tr));
      for (const v of ens) for (const n of names(v)) if (!params.has(n!) && n !== "value") problems.push(`en bilinmeyen parametre ${ns}:${key}: ${n}`);
      for (const v of ens.slice(-1)) for (const n of params) if (!v.includes(`{{${n}}}`)) problems.push(`en parametre eksik ${ns}:${key}: ${n}`);
    }
    expect(problems).toEqual([]);
  });

  it.each(families)("$name: sözlükte sunucuda olmayan kod yok", ({ ns, prefix, table, extra }) => {
    const known = new Set([...Object.keys(table), ...extra]);
    const others = new Set(families.filter((f) => f.ns === ns && f.prefix !== prefix).map((f) => f.prefix).filter(Boolean));
    const stray: string[] = [];
    for (const lng of [tr, en]) {
      for (const [k] of flat(lng[ns] ?? {})) {
        if (prefix ? !k.startsWith(prefix) : [...others].some((o) => k.startsWith(o))) continue;
        if (!prefix && ns === "common") continue;
        const code = k.slice(prefix.length).replace(PLURAL, "");
        if (!known.has(code)) stray.push(`${ns}:${k}`);
      }
    }
    expect([...new Set(stray)]).toEqual([]);
  });
});
