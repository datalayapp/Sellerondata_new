// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { readSetupPending, setupPendingFrom, writeSetupPending } from "./setupMenu.ts";

describe("Kurulum · Eksik görünürlüğü", () => {
  afterEach(() => sessionStorage.clear());

  it("kurulum bitmemiş ve kişi yönetebiliyorsa görünür", () => {
    expect(setupPendingFrom({ status: "pending", manage: true }, false)).toBe(true);
    expect(setupPendingFrom({ status: "in-progress", manage: true }, false)).toBe(true);
  });

  it("kurulum tamam (atlanan da tamam sayılır) ya da kişi yönetemiyorsa görünmez", () => {
    expect(setupPendingFrom({ status: "completed", manage: true }, true)).toBe(false);
    expect(setupPendingFrom({ status: "pending", manage: false }, true)).toBe(false);
  });

  it("yanıt gelene kadar son bilinen değer", () => {
    expect(setupPendingFrom(undefined, true)).toBe(true);
    expect(setupPendingFrom(undefined, false)).toBe(false);
  });

  it("son bilinen değer firmaya bağlı saklanır; başka firma onu okumaz", () => {
    expect(readSetupPending("org-a")).toBe(false);
    writeSetupPending("org-a", true);
    expect(readSetupPending("org-a")).toBe(true);
    expect(readSetupPending("org-b")).toBe(false);
    writeSetupPending("org-a", false);
    expect(readSetupPending("org-a")).toBe(false);
  });
});
