import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** `renameSync` istenince düşer (diskte yer yok, kilitli dosya…): geçici dosya kalmamalı. */
const state = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (state.failRename) throw Object.assign(new Error("EBUSY: sahte"), { code: "EBUSY" });
      return fs.renameSync(from, to);
    },
  };
});

const { KEY_FILE_NAME, fileKeyProvider, pruneKeyFile, rotateKeyFile } = await import("./services/secret-box.ts");

describe("ana anahtar dosyası: yerine yazma düşerse", () => {
  let dir: string | undefined;
  afterEach(() => {
    state.failRename = false;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("döndürme ve temizlikte geçici .ana-anahtar.json.*.tmp silinir, dosya değişmez", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "anahtar-rename-"));
    const file = path.join(dir, KEY_FILE_NAME);
    await fileKeyProvider(file, { protector: null }).create!();
    rotateKeyFile(file, { protector: null });
    const before = readFileSync(file, "utf8");
    state.failRename = true;
    expect(() => rotateKeyFile(file, { protector: null })).toThrow(/EBUSY/);
    expect(() => pruneKeyFile(file, new Set(), { protector: null })).toThrow(/EBUSY/);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
    // Sarılmamış dosyanın sarılması da aynı yoldan geçer.
    const fake = { name: "sahte", protect: (s: string) => s, unprotect: (s: string) => s };
    await expect(fileKeyProvider(file, { protector: fake }).load()).rejects.toThrow(/EBUSY/);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
