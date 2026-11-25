import "../../../i18n/test.ts";
import { describe, expect, it } from "vitest";
import { allUploaded, generateBody, generateCheck, uploadPlan, type UploadRowLike } from "./upload.ts";

const row = (key: string, status: UploadRowLike["status"] = "idle"): UploadRowLike => ({ key, status });
const none = new Set<string>();

describe("yükleme planı", () => {
  it("geçersiz anahtar", () => {
    const p = uploadPlan([row("a/b"), row("  ")], none, false);
    expect(p.problems).toEqual(["invalidKey", "invalidKey"]);
    expect(p.canUpload).toBe(false);
  });
  it("aynı anahtar iki satırda: ikisi de duplicate", () => {
    const p = uploadPlan([row("a1"), row(" a1 "), row("b")], none, false);
    expect(p.problems).toEqual(["duplicate", "duplicate", null]);
    expect(p.canUpload).toBe(false);
  });
  it("yüklenmiş satır sorun almaz ve pending'de yok", () => {
    const p = uploadPlan([row("a/b", "ok"), row("x")], none, false);
    expect(p.problems).toEqual([null, null]);
    expect(p.pending.map((r) => r.key)).toEqual(["x"]);
    expect(p.canUpload).toBe(true);
  });
  it("yüklenmiş satır tekrar saymaz", () => {
    const p = uploadPlan([row("a", "ok"), row("a")], none, false);
    expect(p.problems).toEqual([null, null]);
  });
  it("overwrites var olan anahtarları trim'li verir", () => {
    const p = uploadPlan([row(" a1 "), row("b2")], new Set(["a1"]), false);
    expect(p.overwrites).toEqual(["a1"]);
    expect(p.canUpload).toBe(true);
  });
  it("busy iken yüklenemez", () => {
    expect(uploadPlan([row("a")], none, true).canUpload).toBe(false);
  });
  it("boş pending yüklenemez", () => {
    expect(uploadPlan([], none, false).canUpload).toBe(false);
    expect(uploadPlan([row("a", "ok")], none, false).canUpload).toBe(false);
  });
});

describe("hepsi yüklendi mi", () => {
  it("hepsi ok ise true", () => {
    expect(allUploaded([row("a", "ok"), row("b", "ok")])).toBe(true);
    expect(allUploaded([row("a", "ok"), row("b", "error")])).toBe(false);
  });
});

describe("temadan üret denetimi", () => {
  it("tema 3 harften kısaysa olmaz", () => {
    expect(generateCheck({ theme: "ab", key: "" }, none, false).can).toBe(false);
    expect(generateCheck({ theme: " abc ", key: "" }, none, false).can).toBe(true);
  });
  it("var olan anahtar exists", () => {
    expect(generateCheck({ theme: "çiçek", key: " a1 " }, new Set(["a1"]), false)).toEqual({ keyError: "exists", can: false });
  });
  it("geçersiz anahtar invalid", () => {
    expect(generateCheck({ theme: "çiçek", key: "a/b" }, none, false)).toEqual({ keyError: "invalid", can: false });
  });
  it("boş anahtar serbest", () => {
    expect(generateCheck({ theme: "çiçek", key: "" }, none, false)).toEqual({ keyError: null, can: true });
  });
  it("pending iken olmaz", () => {
    expect(generateCheck({ theme: "çiçek", key: "" }, none, true).can).toBe(false);
  });
});

describe("üretim gövdesi", () => {
  it("boş alanlar gönderilmez", () => {
    expect(generateBody({ theme: " çiçek ", sample: "  ", key: "" })).toEqual({ theme: "çiçek" });
  });
  it("değerler trim'li", () => {
    expect(generateBody({ theme: " t ", sample: " Ayşe ", key: " k1 " })).toEqual({ theme: "t", sampleText: "Ayşe", key: "k1" });
  });
});
