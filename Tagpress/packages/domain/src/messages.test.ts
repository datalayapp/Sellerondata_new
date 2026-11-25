import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FixActionSchema, ISSUE_CODES } from "./issues.ts";
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  FIX_LABELS,
  FIX_LABEL_KEYS,
  ISSUE_MESSAGES,
  ISSUE_MESSAGE_KEYS,
  PRINT_NOTICE_CODES,
  PRINT_WARNING_MESSAGES,
  UNDO_CODES,
  UNDO_MESSAGES,
  errorText,
  fixMsg,
  issueMsg,
  renderMessage,
  templateParams,
  undoMsg,
} from "./messages.ts";
import { PrintTemplateWarningSchema } from "./print.ts";
import { checkTextPreserved } from "./text.ts";

/** Bütün kataloglar: ad → Türkçe şablon. */
const CATALOGS: Record<string, Record<string, { tr: string }>> = {
  errors: ERROR_MESSAGES,
  issues: ISSUE_MESSAGES,
  fixes: FIX_LABELS,
  undo: UNDO_MESSAGES,
  printWarnings: PRINT_WARNING_MESSAGES,
};

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const sample = (tr: string) => Object.fromEntries(templateParams(tr).map((p, i) => [p, `<${p}${i}>`]));

describe("sunucu metin kataloğu", () => {
  for (const [name, catalog] of Object.entries(CATALOGS)) {
    it(`${name}: kodlar kebab, şablonlar dolu, her parametre adı tanımlı ve yerine konuyor`, () => {
      for (const [code, def] of Object.entries(catalog)) {
        expect(code, name).toMatch(KEBAB);
        expect(def.tr.trim(), code).not.toBe("");
        // Yer tutucu dışında süslü parantez yok (sözlükte {{ad}}'a çevrilirken karışmasın).
        expect(def.tr.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, ""), code).not.toMatch(/[{}]/);
        const params = templateParams(def.tr);
        for (const p of params) expect(p, code).toMatch(/^[a-z][A-Za-z0-9]*$/);
        const filled = renderMessage(def.tr, sample(def.tr));
        expect(filled, code).not.toMatch(/\{[A-Za-z]/);
        for (const p of params) expect(filled, code).toContain(`<${p}`);
      }
    });
  }

  it("sorun cümlelerinin kodu sorun kodu, düzeltme adlarının türü düzeltme türü, baskı uyarılarının kodu uyarı kodu", () => {
    const kinds = FixActionSchema.shape.kind.options as readonly string[];
    const warnCodes = PrintTemplateWarningSchema.shape.code.options as readonly string[];
    for (const k of ISSUE_MESSAGE_KEYS) expect(ISSUE_CODES, k).toContain(ISSUE_MESSAGES[k].code);
    for (const k of FIX_LABEL_KEYS) expect(kinds, k).toContain(FIX_LABELS[k].kind);
    for (const [k, d] of Object.entries(PRINT_WARNING_MESSAGES)) expect(warnCodes, k).toContain(d.code);
    // Her düzeltme türünün türle aynı adlı varsayılan adı var (arayüz `labelKey` yoksa `kind`'a bakar).
    for (const kind of kinds) expect(FIX_LABEL_KEYS, kind).toContain(kind);
    // Sözlükte `issues:fix.<anahtar>` düğme adları için ayrıldı.
    expect(ISSUE_MESSAGE_KEYS).not.toContain("fix");
  });

  it("yardımcılar Türkçe cümleyi listeden üretir; parametre yoksa `params` alanı yok", () => {
    expect(errorText("template-key-not-found", { key: "a1" })).toBe('Şablon "a1" bulunamadı.');
    expect(issueMsg("text-very-long", { length: 90, capacity: 80 })).toEqual({
      code: "text-very-long",
      messageKey: "text-very-long",
      message: "Metin çok uzun (90 karakter); bu profilde yaklaşık 80 karaktere kadar sığar.",
      params: { length: 90, capacity: 80 },
    });
    expect(issueMsg("quantity-missing")).toEqual({ code: "quantity-missing", messageKey: "quantity-missing", message: "Adet yok." });
    expect(fixMsg("set-size", { value: "5.2", params: { cm: "5,2" } })).toEqual({ kind: "set-size", label: "5,2 cm", labelKey: "set-size", value: "5.2", params: { cm: "5,2" } });
    expect(fixMsg("skip")).toEqual({ kind: "skip", label: "Bunu alma", labelKey: "skip" });
    expect(undoMsg("jobs-deleted", { count: 3 })).toEqual({ label: "3 iş silindi", code: "jobs-deleted", params: { count: 3 } });
    // Müşteri metni parametreye olduğu gibi girer; parametre içindeki süslü parantez yeniden işlenmez.
    expect(issueMsg("rule-lone-word", { text: "{ve}" }).message).toBe('"{ve}" tek başına satır olmamalı; ait olduğu ifadeyle kalmalı.');
  });

  it("metin koruma sorunu cümlesi ve parametreleri birlikte döner", () => {
    const r = checkTextPreserved(["Anna", "Marko"], "Anna Marco");
    expect(r.ok).toBe(false);
    expect(r.params).toEqual({ at: 9, got: "Anna Marko", want: "Anna Marco" });
    expect(r.problem).toBe(issueMsg("text-changed", r.params!).message);
    expect(r.problem).toBe('Metin değişmiş (9. karakter): "Anna Marko" ≠ "Anna Marco"');
  });

  it("arayüz belgesi (docs/sunucu-kodlari.md) her kodu listeler", () => {
    const doc = readFileSync(new URL("../../../docs/sunucu-kodlari.md", import.meta.url), "utf8");
    const all = [...ERROR_CODES, ...ISSUE_MESSAGE_KEYS, ...FIX_LABEL_KEYS, ...UNDO_CODES, ...Object.keys(PRINT_WARNING_MESSAGES), ...PRINT_NOTICE_CODES];
    const missing = all.filter((c) => !doc.includes(`\`${c}\``));
    expect(missing, "belgeyi yenileyin: node scripts/sunucu-kodlari.ts").toEqual([]);
  });
});
