import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FixAction, ImportCommitResponse, ImportRow, Issue } from "@tagpress/domain";
import { detectFieldMap, parseRecords } from "./services/import/parse.ts";
import { unbalancedPairs } from "./services/import/text-checks.ts";
import { type TestApp, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

const codes = (row: { issues: { code: string }[] }) => row.issues.map((i) => i.code);

describe("dosya biçimleri ve alan eşleme", () => {
  it("dizi, sarmalı nesne, NDJSON ve tek nesne", () => {
    expect(parseRecords('[{"a":1},{"a":2}]')).toMatchObject({ format: "array", records: [{ a: 1 }, { a: 2 }] });
    expect(parseRecords('{"meta":{"x":1},"orders":[{"a":1}]}')).toMatchObject({ format: "wrapped", records: [{ a: 1 }] });
    expect(parseRecords('{"a":1}\n{"a":2}\n')).toMatchObject({ format: "ndjson" });
    expect(parseRecords('{"a":1}')).toMatchObject({ format: "object", records: [{ a: 1 }] });
    expect(() => parseRecords("")).toThrow(/boş/);
    expect(() => parseRecords("{bozuk")).toThrow(/JSON/);
  });

  it("eş anlamlı alan adları (Türkçe/İngilizce, aksan ve boşluk farkı)", () => {
    const { mapping, source } = detectFieldMap([{ "Sipariş No": "1", "Etiket No": "a1", Adet: 3, Text: "Anna", "Ürün Adı": "x", Boyut: "5.2" }]);
    expect(mapping).toEqual({ text: "Text", template: "Etiket No", orderNo: "Sipariş No", quantity: "Adet", product: "Ürün Adı", size: "Boyut" });
    expect(source.text).toBe("name");
  });

  it("metin alanı bulunamazsa en uzun metin içerikten tahmin edilir; kullanıcı eşlemesi ezer", () => {
    const recs = [{ kod: "a1", aciklama_uzun: "Anna & Marco 12.10.2026" }];
    expect(detectFieldMap(recs)).toMatchObject({ mapping: { text: "aciklama_uzun" }, source: { text: "content" } });
    expect(detectFieldMap(recs, { template: "kod" })).toMatchObject({ mapping: { template: "kod" }, source: { template: "user" } });
  });

  it("eşleşmeyen parantez/tırnak", () => {
    expect(unbalancedPairs("Anna (ve Marco")).toEqual(["("]);
    expect(unbalancedPairs("“Grazie” (2026)")).toEqual([]);
    expect(unbalancedPairs('Say "hi')).toEqual(['"']);
  });
});

describe("içe aktarma uçları", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    await seedLanguage(t);
  });
  afterEach(() => t.close());

  const preview = async (records: unknown[], mapping?: unknown) => {
    const r = await t.api("POST", "/api/import/preview", { fileName: "s.json", content: JSON.stringify(records), ...(mapping ? { mapping } : {}) });
    expect(r.status, r.body).toBe(200);
    return r.json;
  };

  it("temiz satır: sorun yok, boyut ve şablon ayrılır, dış tırnak bilgi notu", async () => {
    const p = await preview([
      { "sipariş no": "1001", "etiket no": "A01 5,2 cm", adet: "3", text: "Anna & Marco" },
      { "sipariş no": "1002", "etiket no": "a2", adet: 2, text: '"Grazie di cuore"' },
    ]);
    const [a, b] = p.rows;
    expect(a).toMatchObject({ templateKey: "a1", labelSize: "5.2", quantity: 3, orderNo: "1001", include: true, kind: "label" });
    expect(a.issues).toEqual([]);
    expect(b.text).toBe("Grazie di cuore");
    expect(codes(b)).toEqual(["text-outer-quotes-removed"]);
    expect(b.issues[0].fixes[0]).toMatchObject({ kind: "edit-text", value: '"Grazie di cuore"' });
    expect(p.templateKeys).toEqual(["a1", "a15", "a2", "sticker-istiridye", "sticker-normal"]);
    expect(p.summary).toMatchObject({ total: 2, included: 2, errors: 0 });
  });

  it("bütün içe aktarma sorun kodları", async () => {
    const long = "kelime ".repeat(20).trim();
    const p = await preview([
      /* 0 */ { siparis: "1", etiket: "a1", adet: 1, text: "" },
      /* 1 */ { siparis: "2", etiket: "a1", adet: 1, text: long },
      /* 2 */ { siparis: "3", etiket: "a1", adet: 1, text: "Supercalifragilisticexpialidocious" },
      /* 3 */ { siparis: "4", etiket: "a1", adet: 1, text: "𝓛𝓪 cresima" },
      /* 4 */ { siparis: "5", etiket: "a1", adet: 1, text: "Anna\u0007Marco" },
      /* 5 */ { siparis: "6", etiket: "a1", adet: 1, text: "Mabrouk مبروك 🎉" },
      /* 6 */ { siparis: "7", etiket: "a1", adet: 1, text: "HAPPY BIRTHDAY" },
      /* 7 */ { siparis: "8", etiket: "a1", adet: 1, text: "- jOHN smith (x" },
      /* 8 */ { siparis: "9", etiket: "b77", adet: 1, text: "Anna" },
      /* 9 */ { siparis: "10", etiket: "a16", adet: 1, text: "Anna" },
      /* 10 */ { siparis: "11", etiket: "a1 4.5", adet: 1, text: "Anna" },
      /* 11 */ { siparis: "12", etiket: "a1", text: "Anna" },
      /* 12 */ { siparis: "13", etiket: "a1", adet: "üç", text: "Anna" },
      /* 13 */ { etiket: "a1", adet: 1, text: "Anna" },
      /* 14 */ { siparis: "15", etiket: "a1", adet: 1, text: "Aynı iş" },
      /* 15 */ { siparis: "15", etiket: "a1", adet: 1, text: "Aynı  iş" },
      /* 16 */ { siparis: "17", etiket: "", adet: 1, text: "Sticker yazısı", urun: "Oyster favor" },
      /* 17 */ { siparis: "18", etiket: "5.2", adet: 1, text: "Yalnızca boyut" },
    ]);
    const r = p.rows;
    expect(codes(r[0])).toContain("text-missing");
    expect(r[0].include).toBe(false);
    expect(codes(r[1])).toContain("text-very-long");
    expect(codes(r[2])).toContain("text-word-too-long");
    expect(codes(r[3])).toContain("text-unicode-styled");
    expect(r[3].issues.find((i: Issue) => i.code === "text-unicode-styled").fixes[0]).toMatchObject({ kind: "convert-unicode", value: "La cresima" });
    expect(r[3].text).toBe("𝓛𝓪 cresima"); // metin kendiliğinden DEĞİŞMEZ
    expect(codes(r[4])).toContain("text-unprintable");
    expect(codes(r[5])).toContain("text-fallback-font");
    expect(r[5].issues.find((i: Issue) => i.code === "text-fallback-font").severity).toBe("info");
    expect(codes(r[6])).toContain("text-suspicious");
    const sus = r[7].issues.filter((i: Issue) => i.code === "text-suspicious").map((i: Issue) => i.message).join(" | ");
    expect(sus).toMatch(/başlıyor/);
    expect(sus).toMatch(/boşluk/);
    expect(sus).toMatch(/karışık/);
    expect(sus).toMatch(/Eşleşmeyen/);
    expect(r[7].text).toBe("- jOHN smith (x");
    expect(codes(r[8])).toContain("template-unknown");
    const unknown = r[9].issues.find((i: Issue) => i.code === "template-unknown");
    expect(unknown.fixes.map((f: FixAction) => f.value)).toContain("a15");
    expect(codes(r[10])).toContain("size-unknown");
    expect(r[10].templateKey).toBe("a1");
    expect(codes(r[11])).toContain("quantity-missing");
    expect(codes(r[12])).toContain("quantity-invalid");
    expect(r[12].quantity).toBe("üç");
    expect(codes(r[13])).toContain("order-missing");
    expect(codes(r[14])).not.toContain("duplicate-in-file");
    expect(codes(r[15])).toContain("duplicate-in-file");
    expect(r[15].include).toBe(false);
    expect(r[16]).toMatchObject({ kind: "sticker", templateKey: "sticker-istiridye" });
    expect(codes(r[16])).toContain("sticker-detected");
    expect(codes(r[17])).toContain("template-missing");
    expect(r[17].labelSize).toBe("5.2");
  });

  it("sticker sayfası tanımlı değilse sticker-sheet-missing", async () => {
    const lang = t.inOrg(() => t.ctx.languages.create({ name: "Sayfasız", profile: { name: "s", stickers: { enabled: true, sheets: [] } } }));
    const r = await t.api("POST", "/api/import/preview", { languageId: lang.id, content: JSON.stringify([{ siparis: "1", adet: 1, text: "x", etiket: "" }]) });
    expect(codes(r.json.rows[0])).toEqual(expect.arrayContaining(["sticker-detected", "sticker-sheet-missing"]));
  });

  it("düzenle → doğrula: düzeltme önerisi uygulanınca sorun kalkar, yok sayma çalışır", async () => {
    const p = await preview([{ siparis: "1", etiket: "a16", adet: 1, text: "𝓛𝓪 cresima" }]);
    const row = p.rows[0];
    const fixed = { ...row, text: row.issues.find((i: Issue) => i.code === "text-unicode-styled").fixes[0].value, templateKey: "a15" };
    const v = await t.api("POST", "/api/import/validate", { rows: [fixed] });
    expect(v.status).toBe(200);
    expect(v.json.rows[0].issues).toEqual([]);
    const dismissed = await t.api("POST", "/api/import/validate", { rows: [{ ...fixed, text: "HAPPY DAY", dismissed: ["text-suspicious"] }] });
    expect(codes(dismissed.json.rows[0])).not.toContain("text-suspicious");
    // Hatalar yok sayılamaz.
    const err = await t.api("POST", "/api/import/validate", { rows: [{ ...fixed, templateKey: "yok", dismissed: ["template-unknown"] }] });
    expect(codes(err.json.rows[0])).toContain("template-unknown");
  });

  it("commit: parti + işler; hariç ve boş satırlar alınmaz; ikinci içe aktarmada duplicate-existing", async () => {
    const recs = [
      { siparis: "1", etiket: "a1", adet: 1, text: "Anna" },
      { siparis: "2", etiket: "a2", adet: 1, text: "" },
      { siparis: "3", etiket: "a2", adet: 1, text: "Marco" },
    ];
    const p = await preview(recs);
    p.rows[2].include = false;
    const c = await t.api("POST", "/api/import/commit", { fileName: "s.json", mapping: p.mapping, rows: p.rows, batchName: "Ekim 1" });
    expect(c.status, c.body).toBe(200);
    expect(c.json).toMatchObject({ created: 1, queued: [] });
    expect(c.json.skipped.map((s: ImportCommitResponse["skipped"][number]) => s.index)).toEqual([1, 2]);
    const batches = await t.api("GET", "/api/batches");
    expect(batches.json.batches[0]).toMatchObject({ name: "Ekim 1", total: 1, sourceFile: "s.json" });
    const again = await preview(recs);
    expect(codes(again.rows[0])).toContain("duplicate-existing");
    expect(again.rows[0].include).toBe(false);
    expect(again.rows[0].issues.find((i: Issue) => i.code === "duplicate-existing").message).toMatch(/Ekim 1/);
  });

  it("aynı metin + şablon farklı sipariş no: duplicate-similar (bilgi, tekrar değil); gerçek tekrar duplicate-*", async () => {
    const recs = [
      { siparis: "5261", etiket: "a1", adet: 1, text: "Anna & Marco" },
      { siparis: "5262", etiket: "a1", adet: 1, text: "Anna & Marco" }, // dosyada aynı metin+şablon, başka sipariş
      { siparis: "5262", etiket: "a1", adet: 1, text: "Anna & Marco" }, // gerçek tekrar
      { siparis: "5263", etiket: "a2", adet: 1, text: "Anna & Marco" }, // başka şablon: not yok
    ];
    const p = await preview(recs);
    const sim = (r: ImportRow) => r.issues.find((i: Issue) => i.code === "duplicate-similar");
    expect(sim(p.rows[0])).toBeUndefined();
    expect(sim(p.rows[1])).toMatchObject({ severity: "info" });
    expect(sim(p.rows[1])?.message).toMatch(/5261 numaralı siparişte de var/);
    expect(p.rows[1].include).toBe(true);
    expect(codes(p.rows[2])).toContain("duplicate-in-file");
    expect(sim(p.rows[2])).toBeUndefined();
    expect(sim(p.rows[3])).toBeUndefined();
    // var olan işlerde
    const c = await t.api("POST", "/api/import/commit", { fileName: "b.json", mapping: p.mapping, rows: p.rows.slice(0, 1), batchName: "Benzer" });
    expect(c.status, c.body).toBe(200);
    const again = await preview([{ siparis: "7000", etiket: "a1", adet: 1, text: "Anna & Marco" }]);
    expect(sim(again.rows[0])?.message).toMatch(/5261 numaralı siparişte de var/);
    expect(again.rows[0].include).toBe(true);
    expect(codes(again.rows[0])).not.toContain("duplicate-existing");
  });

  it("elle iş ekleme aynı doğrulamadan geçer", async () => {
    const r = await t.api("POST", "/api/jobs/manual", { text: "Anna & Marco", templateKey: "A15", quantity: "2" });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ templateKey: "a15", quantity: 2, status: "new" });
    expect(r.json.batchName).toMatch(/Elle eklenenler/);
    expect(codes(r.json)).toEqual(["order-missing"]);
  });

  it("geçersiz istek alan yollarıyla 400 döner", async () => {
    const r = await t.api("POST", "/api/import/preview", { content: "" });
    expect(r.status).toBe(400);
    expect(r.json.fields[0].path).toBe("content");
  });

  it("commit edilen işlerin önizleme/çakışma kayıtları korunur (ham kayıt saklanır)", async () => {
    const { commit } = await importJobs(t, [{ siparis: "77", etiket: "a1", adet: 4, text: "Elena", not: "kırmızı" }]);
    const job = await t.api("GET", `/api/jobs/${commit.jobIds[0]}`);
    expect(job.json.raw).toMatchObject({ not: "kırmızı" });
    expect(job.json).toMatchObject({ orderNo: "77", quantity: 4, text: "Elena", textRaw: "Elena" });
  });
});
