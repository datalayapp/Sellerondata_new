import { describe, expect, it } from "vitest";
import { baseLocale, pickInitialLocale } from "./locale.ts";

/**
 * `pickInitialLocale` eşliği: TagPress kopyası platformdaki asıl işlevle (Platform/packages/contracts/src/locale.ts)
 * aynı sonucu verir. Platform dosyası adresle yüklenir (tip denetimi Platform'a bağlanmasın).
 */
type Pick = (saved: unknown, device: readonly unknown[] | null | undefined, supported?: readonly string[]) => string;
type Base = (v: unknown, supported?: readonly string[]) => string | null;

const platformUrl = new URL("../../../../../Platform/packages/contracts/src/locale.ts", import.meta.url).href;

const CASES: Array<[saved: unknown, device: readonly unknown[] | null | undefined, supported?: readonly string[]]> = [
  ["tr", ["en-US"]],
  ["en", ["tr-TR"]],
  ["TR", []],
  ["tr-TR", []],
  ["en_GB", []],
  ["de", ["tr-TR", "en"]],
  [null, ["de-DE", "tr", "en"]],
  [undefined, ["en-GB"]],
  ["", undefined],
  [[null, "en"], ["tr"]],
  [["fr", "de"], ["fr-FR"]],
  [[undefined, "tr"], []],
  [42, ["xx", 7, "EN"]],
  [null, null],
  [{}, ["ar"]],
  ["tr", ["en"], ["en"]],
  [null, ["tr"], ["tr"]],
  [null, [], ["tr"]],
  [" tr ", []],
];

describe("pickInitialLocale eşliği", () => {
  it("platformdaki işlevle her durumda aynı sonucu verir", async () => {
    const platform = (await import(/* @vite-ignore */ platformUrl)) as { pickInitialLocale: Pick; baseLocale: Base };
    for (const [saved, device, supported] of CASES) {
      expect(pickInitialLocale(saved, device, supported), JSON.stringify([saved, device, supported])).toBe(platform.pickInitialLocale(saved, device, supported));
    }
    for (const v of ["tr", "TR-tr", "en_US", "", " en", "de", null, 3]) expect(baseLocale(v)).toBe(platform.baseLocale(v));
  });

  it("kayıtlı tercih cihaz dilinden önce gelir; hiçbiri yoksa İngilizce", () => {
    expect(pickInitialLocale(["tr", null], ["en-US"])).toBe("tr");
    expect(pickInitialLocale([null, undefined], ["tr-TR"])).toBe("tr");
    expect(pickInitialLocale(null, ["de-DE"])).toBe("en");
  });
});
