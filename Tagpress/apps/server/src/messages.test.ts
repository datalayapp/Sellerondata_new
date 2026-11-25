import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  type ApiError,
  type ErrorCode,
  type Issue,
  FIX_LABEL_KEYS,
  FIX_LABELS,
  ISSUE_MESSAGE_KEYS,
  ISSUE_MESSAGES,
  PRINT_WARNING_MESSAGES,
  UNDO_CODES,
  UNDO_MESSAGES,
  renderMessage,
  templateParams,
} from "@tagpress/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestApp, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

/**
 * Sunucunun gönderdiği her kullanıcı metni kod + parametreyle gider ve kod `@tagpress/domain` `messages.ts` listesindedir.
 * Kaynak taraması: sunucu ve paketlerde (testler hariç) yazılan her kod listede var; listedeki her kod bir yerde kullanılıyor.
 */

const TAGPRESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["apps/server/src", ...readdirSync(path.join(TAGPRESS, "packages")).map((p) => `packages/${p}/src`)];

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules") walk(full);
      } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !full.includes(`${path.sep}test${path.sep}`)) {
        out.push({ file: path.relative(TAGPRESS, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  for (const r of ROOTS) {
    const dir = path.join(TAGPRESS, r);
    try {
      if (statSync(dir).isDirectory()) walk(dir);
    } catch {
      /* paketin src'si yok */
    }
  }
  return out;
}

/** `(` konumundan başlayan çağrının üst düzey argümanları (dizgi, şablon dizgi ve parantezler atlanarak). */
function callArgs(src: string, open: number): string[] {
  const args: string[] = [];
  const stack: string[] = [];
  let start = open + 1;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]!;
    const top = stack[stack.length - 1];
    if (top === "`") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && src[i + 1] === "{") {
        stack.push("${");
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "`") stack.push("`");
    else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      if (!stack.length) {
        args.push(src.slice(start, i).trim());
        return args;
      }
      stack.pop();
    } else if (c === "," && !stack.length) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

/** Argümandaki kod dizgileri; `koşul ? "a" : "b"` biçiminde yalnız seçenekler. */
function literals(arg: string | undefined): string[] {
  if (!arg) return [];
  const q = arg.indexOf("?");
  const part = q >= 0 ? arg.slice(q) : arg;
  return [...part.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]!);
}

interface Use {
  kind: "error" | "issue" | "fix" | "undo" | "print";
  code: string;
  file: string;
}

function scan(): { uses: Use[]; codeless: string[] } {
  const uses: Use[] = [];
  const codeless: string[] = [];
  // Hata çağrıları yalnız sunucuda (paketlerde aynı adlı başka işlevler var: motorun `fail`, Gemini'nin `HttpError`'ı).
  const calls: [RegExp, Use["kind"], number][] = [
    [/\bfail(?:Fields)?\(/g, "error", 0],
    [/\bfailStatus\(/g, "error", 1],
    [/\berrorText\(/g, "error", 0],
    [/\bnew HttpError\(/g, "error", 3],
    [/\bparseBody\(/g, "error", 2],
    [/\bissueMsg\(/g, "issue", 0],
    [/\bfixMsg\(/g, "fix", 0],
    [/\bundoMsg\(/g, "undo", 0],
    [/\bprintWarningMsg\(/g, "print", 0],
  ];
  for (const { file, text } of sources()) {
    if (file.replaceAll("\\", "/").endsWith("domain/src/messages.ts")) continue;
    const server = file.replaceAll("\\", "/").startsWith("apps/server/");
    for (const [re, kind, index] of calls) {
      if (kind === "error" && !server) continue;
      for (const m of text.matchAll(re)) {
        // İşlev tanımları (`export function fail<C …>(`) çağrı değildir.
        if (/function\s+$/.test(text.slice(Math.max(0, m.index! - 20), m.index!))) continue;
        const args = callArgs(text, m.index! + m[0].length - 1);
        if (re.source.includes("HttpError") && args.length < 4) codeless.push(`${file}: ${args.join(", ").slice(0, 80)}`);
        for (const code of literals(args[index])) uses.push({ kind, code, file });
      }
    }
    // HttpError alt sınıfları: super(durum, mesaj, alanlar, "kod", …)
    if (server && /extends HttpError/.test(text)) {
      for (const m of text.matchAll(/\bsuper\(/g)) {
        const args = callArgs(text, m.index! + m[0].length - 1);
        if (args.length < 4) codeless.push(`${file}: super(${args.join(", ").slice(0, 80)})`);
        for (const code of literals(args[3])) uses.push({ kind: "error", code, file });
      }
    }
  }
  return { uses, codeless };
}

const CATALOG: Record<Use["kind"], readonly string[]> = {
  error: ERROR_CODES,
  issue: ISSUE_MESSAGE_KEYS,
  fix: FIX_LABEL_KEYS,
  undo: UNDO_CODES,
  print: Object.keys(PRINT_WARNING_MESSAGES),
};

describe("kod listesi kapsamı (kaynak taraması)", () => {
  const { uses, codeless } = scan();

  it("tarama gerçekten çağrı buluyor", () => {
    for (const kind of Object.keys(CATALOG) as Use["kind"][]) expect(uses.filter((u) => u.kind === kind).length, kind).toBeGreaterThan(0);
  });

  it("sunucuda fırlatılan / üretilen her kod listede var", () => {
    const unknown = uses.filter((u) => !CATALOG[u.kind].includes(u.code)).map((u) => `${u.kind} "${u.code}" (${u.file})`);
    expect(unknown).toEqual([]);
  });

  it("kodsuz HttpError yok", () => {
    expect(codeless).toEqual([]);
  });

  it("listedeki her kod kaynakta kullanılıyor (ölü kayıt yok)", () => {
    const used = new Set(uses.map((u) => `${u.kind}:${u.code}`));
    // parseBody'nin varsayılanı (`util/errors.ts`) çağrıda yazılmaz.
    used.add("error:request-invalid");
    // Görsel denetim üründen kalktı (SUNUCU-PLANI §9): artık üretilmez, ama eski varyasyonlarda saklı sorunlar ve
    // düzeltme önerileri bu kodlarla okunur (arayüz sözlüğü de taşır; veri silinmez).
    for (const legacy of ["issue:critique-issue", "issue:critique-issue-fixed", "fix:request-fix"]) used.add(legacy);
    const dead = (Object.keys(CATALOG) as Use["kind"][]).flatMap((k) => CATALOG[k].filter((c) => !used.has(`${k}:${c}`)).map((c) => `${k}:${c}`));
    expect(dead).toEqual([]);
  });

  it("`issue(kod, …, issueMsg(anahtar))` / `problem(…)` çağrılarında kod, cümlenin kaydındaki kodla aynı", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const { file, text } of sources()) {
      for (const m of text.matchAll(/\b(?:issue|problem)\(/g)) {
        if (/function\s+$|const\s+$/.test(text.slice(Math.max(0, m.index! - 20), m.index!))) continue;
        const args = callArgs(text, m.index! + m[0].length - 1);
        const code = /^"([a-z-]+)"$/.exec(args[0] ?? "")?.[1];
        if (!code) continue;
        for (const k of args.slice(1).join(",").matchAll(/\bissueMsg\(\s*"([a-z-]+)"/g)) {
          const def = ISSUE_MESSAGES[k[1] as keyof typeof ISSUE_MESSAGES];
          checked++;
          if (def?.code !== code) wrong.push(`${file}: issue("${code}") ← issueMsg("${k[1]}") (${def?.code})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(wrong).toEqual([]);
  });

  it("her kaydın parametre adları şablondan çıkar ve hepsi tanımlı", () => {
    const all: Record<string, { tr: string }>[] = [ERROR_MESSAGES, ISSUE_MESSAGES, FIX_LABELS, UNDO_MESSAGES, PRINT_WARNING_MESSAGES];
    for (const catalog of all) {
      for (const [code, def] of Object.entries(catalog)) {
        const params = templateParams(def.tr);
        const filled = renderMessage(def.tr, Object.fromEntries(params.map((p) => [p, 1])));
        expect(filled, code).not.toMatch(/\{[A-Za-z]/);
      }
    }
  });
});

/** Hata yanıtı: kod listede, `error` listedeki şablonun parametrelerle doldurulmuş hâli, parametre adları şablonunkiler. */
function expectCoded(res: { status: number; json: ApiError; body: string }, code: ErrorCode, params?: Record<string, string | number>) {
  expect(res.json?.code, res.body).toBe(code);
  const def = ERROR_MESSAGES[code];
  if (def.status !== null) expect(res.status, res.body).toBe(def.status);
  expect(Object.keys(res.json.params ?? {}).sort()).toEqual(templateParams(def.tr).sort());
  if (params) expect(res.json.params).toEqual(params);
  expect(res.json.error).toBe(renderMessage(def.tr, res.json.params));
}

describe("yanıtlar kod + parametre taşır", () => {
  let t: TestApp;
  let lang: string;
  beforeEach(async () => {
    t = await makeApp();
    lang = await seedLanguage(t);
  });
  afterEach(() => t.close());

  it("bulunamadı: parametresiz ve parametreli", async () => {
    expectCoded(await t.api("GET", "/api/jobs/yok"), "job-not-found");
    const r = await t.api("GET", `/api/languages/${lang}/templates/zz9`);
    expectCoded(r, "template-key-not-found", { key: "zz9" });
    expect(r.json.error).toBe('Şablon "zz9" bulunamadı.');
  });

  it("doğrulama: kod + alanlar; bozuk JSON; X-Studio başlığı eksik", async () => {
    const bad = await t.api("POST", "/api/jobs/delete", { ids: [] });
    expectCoded(bad, "request-invalid");
    expect(bad.json.fields?.[0]?.path).toBe("ids");
    const json = await t.app.inject({ method: "POST", url: "/api/jobs/delete", headers: { "x-studio": "1", "content-type": "application/json" }, payload: "{bozuk" });
    expectCoded({ status: json.statusCode, json: json.json(), body: json.body }, "body-invalid-json");
    expectCoded(await t.api("POST", "/api/jobs/delete", { ids: ["x"] }, { "x-studio": "0" }), "studio-header-missing");
  });

  it("içe aktarma sorunları: messageKey + params, düzeltmeler labelKey (+ params)", async () => {
    const r = await t.api("POST", "/api/import/preview", {
      fileName: "s.json",
      content: JSON.stringify([
        { "sipariş no": "1", "etiket no": "a1", adet: "çok", text: "Anna" },
        { "sipariş no": "1", "etiket no": "a1", adet: "çok", text: "Anna" },
        { "sipariş no": "2", "etiket no": "a1 9,9 cm", adet: 1, text: "Marco" },
      ]),
    });
    expect(r.status, r.body).toBe(200);
    const [first, second, third] = r.json.rows;
    const qty = first.issues.find((i: Issue) => i.code === "quantity-invalid");
    expect(qty).toMatchObject({ messageKey: "quantity-invalid", params: { value: "çok" }, message: 'Adet geçersiz ("çok"); pozitif tam sayı olmalı.' });
    expect(qty.fixes).toEqual([{ kind: "set-quantity", label: "Adeti düzelt", labelKey: "fix-quantity" }]);
    const dup = second.issues.find((i: Issue) => i.code === "duplicate-in-file");
    expect(dup).toMatchObject({ messageKey: "duplicate-in-file", params: { row: 1 }, message: "Dosyada 1. satırla aynı iş." });
    const size = third.issues.find((i: Issue) => i.code === "size-unknown");
    expect(size).toMatchObject({ messageKey: "size-unknown", params: { size: "9.9" } });
    expect(size.fixes[0]).toMatchObject({ kind: "set-size", labelKey: "set-size", params: { cm: expect.anything() } });
    expect(size.fixes[0].label).toBe(`${size.fixes[0].params.cm} cm`);
    // Her sorunun cümlesi listedeki şablondan; parametre adları şablonunkiler.
    for (const row of r.json.rows) {
      for (const i of row.issues) {
        const def = ISSUE_MESSAGES[i.messageKey as keyof typeof ISSUE_MESSAGES];
        expect(def, i.message).toBeDefined();
        expect(def.code).toBe(i.code);
        expect(Object.keys(i.params ?? {}).sort()).toEqual(templateParams(def.tr).sort());
        expect(i.message).toBe(renderMessage(def.tr, i.params));
        for (const f of i.fixes) expect(f.label).toBe(renderMessage(FIX_LABELS[f.labelKey as keyof typeof FIX_LABELS].tr, f.params));
      }
    }
  });

  it("geri al: kod + sayı; ikinci geri alma `undo-used`", async () => {
    const { commit } = await importJobs(t, [
      { "sipariş no": "1", "etiket no": "a1", adet: 1, text: "Anna" },
      { "sipariş no": "2", "etiket no": "a2", adet: 1, text: "Marco" },
    ]);
    const del = await t.api("POST", "/api/jobs/delete", { ids: commit.jobIds });
    expect(del.status, del.body).toBe(200);
    expect(del.json).toMatchObject({ label: "2 iş silindi", code: "jobs-deleted", params: { count: 2 } });
    expect(del.json.label).toBe(renderMessage(UNDO_MESSAGES["jobs-deleted"].tr, del.json.params));
    expect((await t.api("POST", `/api/undo/${del.json.undoToken}`)).status).toBe(200);
    expectCoded(await t.api("POST", `/api/undo/${del.json.undoToken}`), "undo-used");
    expectCoded(await t.api("POST", "/api/undo/yok"), "undo-not-found");
  });
});
