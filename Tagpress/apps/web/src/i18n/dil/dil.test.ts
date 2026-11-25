import { describe, expect, it } from "vitest";
import * as en from "./en.ts";
import * as tr from "./tr.ts";

describe("tr: ek uyumu ve sayı biçimi", () => {
  it("pctOwn iyelik ekini seçer", () => {
    expect(tr.pctOwn(0.97)).toBe("%97'si");
    expect(tr.pctOwn(0.73)).toBe("%73'ü");
    expect(tr.pctOwn(0.11)).toBe("%11'i");
    expect(tr.pctOwn(0.29)).toBe("%29'u");
    expect(tr.pctOwn(0.6)).toBe("%60'ı");
    expect(tr.pctOwn(1)).toBe("%100'ü");
    expect(tr.pctOwn(0.973)).toBe("%97,3'ü");
  });
  it("pct, pctText, num, joinList", () => {
    expect(tr.pct(0.9)).toBe("%90");
    expect(tr.pctText(0.973)).toBe("97,3");
    expect(tr.num(1.5)).toBe("1,5");
    expect(tr.joinList([])).toBe("");
    expect(tr.joinList(["a"])).toBe("a");
    expect(tr.joinList(["a", "b"])).toBe("a ve b");
    expect(tr.joinList(["a", "b", "c"])).toBe("a, b ve c");
  });
});

describe("en: aynı işlev adları, İngilizce çıktı", () => {
  it("pctOwn ek almaz", () => {
    expect(en.pctOwn(0.97)).toBe("97%");
    expect(en.pctOwn(0.73)).toBe("73%");
    expect(en.pctOwn(1)).toBe("100%");
    expect(en.pctOwn(0.973)).toBe("97.3%");
  });
  it("pct, pctText, num, joinList", () => {
    expect(en.pct(0.9)).toBe("90%");
    expect(en.pctText(0.973)).toBe("97.3");
    expect(en.num(1234.5)).toBe("1,234.5");
    expect(en.joinList([])).toBe("");
    expect(en.joinList(["a"])).toBe("a");
    expect(en.joinList(["a", "b"])).toBe("a and b");
    expect(en.joinList(["a", "b", "c"])).toBe("a, b, and c");
  });
  it("iki modül aynı dışa aktarımları taşır", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(tr).sort());
  });
});
