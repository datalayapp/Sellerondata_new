// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestLocale } from "../../../i18n/test.ts";
import { click, waitFor } from "../../../tezgah/test/render.tsx";
import { ac, denetle, dugme, kur, ref } from "./test-veri.tsx";

const REFS = [
  ref("r1", "Elif & Kerem 14.06.2027"),
  ref("r2", "Ayse & Can", { split: "test", orderNo: "8741", templateKey: "A12" }),
  ref("r3", "Defne Vaftiz", { orderNo: "8790", templateKey: "C07", program: [ref("x", "Defne").user[0]!], programMeta: { variantId: "v1", engine: "motor", profileVersion: 3 } }),
];

let calls: ReturnType<typeof kur>;
beforeEach(() => {
  calls = kur({ refs: REFS, routes: { "/api/references/r2": { ...REFS[1], split: "train" } } });
});
afterEach(() => {
  document.body.innerHTML = "";
  setTestLocale("tr");
});

const kartlar = () => [...document.querySelectorAll<HTMLButtonElement>(".td-or-kart")];
const tab = (id: string) => document.querySelector<HTMLElement>(`.tz-tabs [data-tab-id="${id}"]`)!;

describe("Tasarım dili: Örnekler", () => {
  it("kartlar, küme süzgeci ve iş satırında örnek sayısı", async () => {
    const r = await ac("#/tasarim-dili/ornekler");
    await waitFor(() => kartlar().length === 3);
    expect(document.querySelector('.tz-btabs [data-tab-id="ornekler"]')?.textContent).toContain("3");
    expect(tab("all").textContent).toContain("3");
    expect(tab("train").textContent).toContain("2");
    expect(tab("test").textContent).toContain("1");
    await click(tab("test"));
    expect(kartlar().map((k) => k.textContent)).toEqual([expect.stringContaining("Ayse & Can")]);
    expect(kartlar()[0]?.textContent).toContain("№ 8741 · A12 · test");
    expect(denetle("ornekler")).toEqual({ label: "ornekler", primary: 0, unnamed: [] });
    await r.unmount();
  });

  it("ayrıntı sağ panelde: son hâl, programın önerisi, satırlar, kaynak; küme seçimi kaydedilir", async () => {
    const r = await ac("#/tasarim-dili/ornekler");
    await waitFor(() => kartlar().length === 3);
    // İlk kart açık gelir.
    expect(document.querySelector(".tz-pnl--r .tz-pnl-t")?.textContent).toBe("Elif & Kerem 14.06.2027");
    await click(kartlar().find((k) => k.textContent?.includes("Defne"))!);
    const panel = document.querySelector(".tz-pnl--r")!;
    expect(panel.querySelector(".tz-pnl-t")?.textContent).toBe("Defne Vaftiz");
    expect(panel.textContent).toContain("Son hâl");
    expect(panel.textContent).toContain("Programın önerisi · sürüm 3");
    expect(panel.textContent).toContain("Kaynak: Figma'dan aktarıldı (eski)");
    expect(panel.textContent).toContain("Sizin satırlarınız");
    expect(panel.textContent).toContain("Great Vibes");
    expect(panel.textContent).toMatch(/\d+(,\d)? pt/);

    await click(kartlar().find((k) => k.textContent?.includes("Ayse"))!);
    const train = [...document.querySelectorAll<HTMLElement>(".tz-pnl--r [role=radio]")].find((b) => b.textContent === "Öğrenme")!;
    await click(train);
    const patch = await waitFor(() => calls.find((c) => c.method === "PATCH"));
    expect(patch.url).toBe("/api/references/r2");
    expect(patch.body).toEqual({ split: "train" });

    await click(document.querySelector<HTMLElement>('.tz-pnl--r [aria-label="Ayrıntıyı kapat"]')!);
    expect(document.querySelector(".tz-pnl--r")?.textContent).toContain("Ayrıntı için bir örnek seçin");
    await r.unmount();
  });

  it("örnek yoksa boş durum ve Oluştur'a götüren tek birincil düğme", async () => {
    calls = kur({ refs: [] });
    const gidilen: string[][] = [];
    const r = await ac("#/tasarim-dili/ornekler", (_id, rest) => gidilen.push(rest ?? []));
    await waitFor(() => document.querySelector(".tz-empty"));
    expect(document.body.textContent).toContain("Henüz örnek yok");
    expect(denetle("ornekler-bos").primary).toBe(1);
    await click(dugme("Nasıl yüklenir?")!);
    expect(gidilen.at(-1)).toEqual(["olustur"]);
    await r.unmount();
  });
});
