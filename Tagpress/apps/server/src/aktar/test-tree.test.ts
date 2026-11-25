import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFiles, listTargetFiles } from "./files.ts";
import { makeDirLink, removeDirLink } from "./test-tree.ts";

/**
 * Testlerin klasör bağlantısı yardımcıları her platformda aynı yoldan çalışır (CI Linux'ta: sembolik bağ; Windows'ta: junction).
 * CI 44976845035: Linux'ta bağlantı `rmdir` ile kaldırılamıyordu (ENOTDIR); `removeDirLink` `lstat` ile ayırır, `unlink` ile siler.
 */

let work: string | null = null;
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = null;
});

describe("klasör bağlantısı (test yardımcısı)", () => {
  it("bağlantı kurulur, aktarım onu görür ve durur; kaldırmak yalnız bağlantıyı siler", () => {
    work = mkdtempSync(path.join(os.tmpdir(), "tagpress-baglanti-"));
    const outside = path.join(work, "disari");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "gizli.txt"), "dışarıda");
    const root = path.join(work, "kok");
    mkdirSync(path.join(root, "referanslar"), { recursive: true });
    const link = path.join(root, "referanslar", "baglanti");

    makeDirLink(outside, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => collectFiles(root)).toThrow(/bağlantı/);
    expect(() => listTargetFiles(root)).toThrow(/bağlantı/);

    removeDirLink(link);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(path.join(outside, "gizli.txt"), "utf8")).toBe("dışarıda");
    expect(collectFiles(root).files).toEqual([]);
  });

  it("gerçek klasörü bağlantı sanıp silmez", () => {
    work = mkdtempSync(path.join(os.tmpdir(), "tagpress-baglanti-"));
    const dir = path.join(work, "gercek");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a.txt"), "a");
    expect(() => removeDirLink(dir)).toThrow(/Bağlantı değil/);
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a");
  });
});
