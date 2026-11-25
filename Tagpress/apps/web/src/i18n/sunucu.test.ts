import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiFailure } from "../lib/api.ts";
import { formatUsd as legacyUsd } from "../lib/format.ts";
import { formatNumber, formatUsd } from "./bicim.ts";
import { i18n } from "./index.ts";
import { fixLabel, issueText, serverText, serverTextDetail, undoText } from "./sunucu.ts";
import { setTestLocale } from "./test.ts";

// Sunucudan gelen kayıt: kod listesi dışındaki (eski ya da bilinmeyen) kodlar da gelebilir.
type IssueIn = Parameters<typeof issueText>[0];
type FixIn = Parameters<typeof fixLabel>[0];
const issue = (x: { code: string; message: string; messageKey?: string; params?: Record<string, string | number> }) => x as IssueIn;
const fix = (x: { kind: string; label: string; labelKey?: string; value?: string; params?: Record<string, string | number> }) => x as FixIn;

// Testler sözlüğe geçici anahtar ekler; her testten sonra sözlük ilk haline döner.
let saved: Record<string, Record<string, unknown>> = {};
beforeEach(() => {
  saved = structuredClone(i18n.store.data) as typeof saved;
});
afterEach(() => {
  for (const [lng, nss] of Object.entries(saved)) for (const [ns, data] of Object.entries(nss)) {
    i18n.removeResourceBundle(lng, ns);
    i18n.addResourceBundle(lng, ns, data, true, true);
  }
  setTestLocale("tr");
});

describe("sunucu metni köprüsü", () => {
  it("TR'de sunucunun metni aynen (bugünkü davranış)", () => {
    expect(serverText(new ApiFailure(400, { error: "Şablon bulunamadı." }))).toBe("Şablon bulunamadı.");
    expect(serverText(new Error("Ağ hatası"))).toBe("Ağ hatası");
    expect(serverText("tuhaf")).toBe(i18n.t("errors:generic"));
  });

  it("EN'de sözlükte karşılığı yoksa genel metin, asıl metin ayrıntıda", () => {
    setTestLocale("en");
    const r = serverTextDetail(new ApiFailure(400, { error: "Şablon bulunamadı.", code: "template-missing" }));
    expect(r.text).toBe("Something went wrong.");
    expect(r.detail).toBe("Şablon bulunamadı.");
  });

  it("hata kodu sözlükte varsa o kullanılır", () => {
    i18n.addResource("tr", "errors", "deneme-kodu", "Sözlükten");
    i18n.addResource("en", "errors", "deneme-kodu", "From dictionary");
    const e = new ApiFailure(400, { error: "sunucu", code: "deneme-kodu" });
    expect(serverText(e)).toBe("Sözlükten");
    setTestLocale("en");
    expect(serverText(e)).toBe("From dictionary");
  });

  it("hata: errors:<code> parametrelerle", () => {
    // sunucunun cümlesi farklı olsa da sözlükteki (parametreli) metin kullanılır
    const e = new ApiFailure(404, { error: "eski cümle", code: "template-key-not-found", params: { key: "a15" } });
    expect(serverText(e)).toBe('Şablon "a15" bulunamadı.');
    setTestLocale("en");
    expect(serverText(e)).toBe('Template "a15" not found.');
    expect(serverTextDetail(e).detail).toBeUndefined();
  });

  it("sorun: önce messageKey, sonra code (parametrelerle), sonra sunucunun mesajı", () => {
    const lines = { code: "text-very-long", messageKey: "text-very-long-lines", params: { lines: 5, max: 3 }, message: "sunucu" };
    expect(issueText(issue(lines))).toBe("Müşteri 5 satır vermiş; profil en fazla 3 satıra izin veriyor.");
    setTestLocale("en");
    expect(issueText(issue(lines))).toBe("The customer gave 5 lines; the profile allows at most 3.");
    // messageKey sözlükte yoksa koda düşer
    expect(issueText(issue({ code: "collision", messageKey: "yok-boyle-bir-anahtar", message: "sunucu" }))).toBe("The text could not be placed without hitting the decoration or the cut line.");
    // eski kayıt: kod da sözlükte yoksa sunucunun mesajı
    expect(issueText(issue({ code: "eski-kod", message: "Eski cümle." }))).toBe("Eski cümle.");
    // çoğul
    expect(issueText(issue({ code: "text-unprintable", messageKey: "text-unprintable-broken", params: { count: 1 }, message: "x" }))).toContain("in 1 place)");
    expect(issueText(issue({ code: "text-unprintable", messageKey: "text-unprintable-broken", params: { count: 3 }, message: "x" }))).toContain("in 3 places)");
  });

  it("düzeltme: önce labelKey, sonra kind (value ve parametrelerle), sonra sunucunun adı", () => {
    expect(fixLabel(fix({ kind: "set-size", labelKey: "set-size", params: { cm: "3,8" }, label: "3,8 cm", value: "3.8" }))).toBe("3,8 cm");
    setTestLocale("en");
    expect(fixLabel(fix({ kind: "edit-text", labelKey: "restore-quotes", label: "Tırnakları geri koy" }))).toBe("Put the quotes back");
    expect(fixLabel(fix({ kind: "edit-text", labelKey: "yok-boyle", label: "Metni düzenle" }))).toBe("Edit text");
    expect(fixLabel(fix({ kind: "bilinmeyen", label: "Sunucu adı" }))).toBe("Sunucu adı");
    i18n.addResource("en", "issues", "fix.deneme", "Set to {{value}}");
    expect(fixLabel(fix({ kind: "x", labelKey: "deneme", label: "y", value: "4" }))).toBe("Set to 4");
  });

  it("geri al: common:undo.<code> parametrelerle; kod yoksa TR'de sunucunun açıklaması, EN'de genel metin", () => {
    expect(undoText({ label: "3 iş silindi", code: "jobs-deleted", params: { count: 3 } })).toBe("3 iş silindi");
    expect(undoText({ label: "3 iş silindi" })).toBe("3 iş silindi");
    setTestLocale("en");
    expect(undoText({ label: "3 iş silindi", code: "jobs-deleted", params: { count: 3 } })).toBe("3 jobs deleted");
    expect(undoText({ label: "1 iş silindi", code: "jobs-deleted", params: { count: 1 } })).toBe("1 job deleted");
    expect(undoText({ label: "Varyasyon silindi", code: "variant-deleted" })).toBe("Variant deleted");
    expect(undoText({ label: "3 iş silindi" })).toBe("Done. You can undo it.");
  });
});

describe("biçim", () => {
  it("TR para çıktısı lib/format.ts ile aynı", () => {
    for (const n of [0, 0.0042, 0.006, 0.125, 1.25, 1234.5, null, Number.NaN]) {
      expect(formatUsd(n)).toBe(legacyUsd(n));
      expect(formatUsd(n, { approx: true })).toBe(legacyUsd(n, { approx: true }));
    }
  });

  it("EN'de ondalık nokta", () => {
    setTestLocale("en");
    expect(formatUsd(1.25)).toBe("$1.25");
    expect(formatNumber(3.8, { maximumFractionDigits: 1 })).toBe("3.8");
    setTestLocale("tr");
    expect(formatNumber(3.8, { maximumFractionDigits: 1 })).toBe("3,8");
  });
});
