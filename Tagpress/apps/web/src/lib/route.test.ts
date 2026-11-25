import { describe, expect, it } from "vitest";
import { activeTab, parseHash, phoneNote, routeHash, screenKind } from "./route.ts";

describe("ekran türü (yerleşim)", () => {
  const kind = (hash: string) => screenKind(parseHash(hash));
  it.each([
    "#/uretim/ice-aktar",
    "#/duzelt/v1",
    "#/sablonlar/a15",
    "#/baski",
    "#/baski/masa/s1",
    "#/baski/sablonlar/t1",
    "#/vitrin",
  ])("%s çalışma ekranı (kenardan kenara)", (hash) => {
    expect(kind(hash)).toBe("work");
  });

  it.each([
    "#/uretim",
    "#/uretim?is=j1",
    "#/yok",
    "#/kurulum",
    "#/kurulum/2",
    "#/ayarlar",
    "#/ayarlar/uretim",
    "#/tasarim-dili",
    "#/tasarim-dili/ozet",
    "#/tasarim-dili/surumler",
    "#/tasarim-dili/ogren",
    "#/tasarim-dili/ornekler",
    "#/tasarim-dili/kurallar",
    "#/tasarim-dili/kurallar/renk",
    "#/tasarim-dili/dene",
    "#/tasarim-dili/olustur",
    "#/tasarim-dili/olustur/o1",
    "#/sablonlar",
    "#/baski/sablonlar",
    "#/baski/arsiv",
  ])("%s form ya da liste ekranı (sütun)", (hash) => {
    expect(kind(hash)).toBe("column");
  });

  it.each(["#/uretim", "#/uretim/ice-aktar", "#/duzelt/v1", "#/baski", "#/tasarim-dili/kurallar", "#/tasarim-dili/dene", "#/tasarim-dili/olustur/o1"])(
    "%s telefonda not gösterir",
    (hash) => {
      expect(phoneNote(parseHash(hash))).toBe(true);
    },
  );

  it.each(["#/kurulum", "#/ayarlar/uretim", "#/tasarim-dili", "#/tasarim-dili/ozet", "#/tasarim-dili/ornekler", "#/sablonlar", "#/baski/arsiv"])(
    "%s telefonda da açılır",
    (hash) => {
      expect(phoneNote(parseHash(hash))).toBe(false);
    },
  );
});

describe("Tezgâh rotaları", () => {
  it("rota kimliği, parçalar ve sorgu", () => {
    const r = parseHash("#/baski/masa/abc?x=1");
    expect(r.id).toBe("baski");
    expect(r.rest).toEqual(["masa", "abc"]);
    expect(r.query.get("x")).toBe("1");
    expect(parseHash("#/duzelt/v1?don=%23%2Fbaski").id).toBe("duzelt");
    expect(parseHash("#/kurulum/2").rest).toEqual(["2"]);
    expect(parseHash("#/vitrin").id).toBe("vitrin");
  });

  it("bilinmeyen ve boş adres Üretim'e düşer", () => {
    expect(parseHash("").id).toBe("uretim");
    expect(parseHash("#/yok/bir/sey").id).toBe("uretim");
    expect(parseHash("#/yok").rest).toEqual([]);
  });

  it("eski karşılaştırma bağlantısı tek ekrana düşer", () => {
    const r = parseHash("#/uretim/karsilastir?is=j1");
    expect(r.id).toBe("uretim");
    expect(r.rest).toEqual([]);
    expect(r.query.get("is")).toBe("j1");
  });

  it("adres üretme ve geri çözme", () => {
    const h = routeHash("duzelt", ["v 1"], { don: "#/uretim?is=j1", bos: "" });
    expect(h).toBe("#/duzelt/v%201?don=%23%2Furetim%3Fis%3Dj1");
    const r = parseHash(h);
    expect(r.rest).toEqual(["v 1"]);
    expect(r.query.get("don")).toBe("#/uretim?is=j1");
  });

  it("etkin menü: Düzelt'te geri dönülecek adresin sekmesi; Kurulum ve vitrinde yok", () => {
    expect(activeTab(parseHash("#/duzelt/v1"))).toBe("uretim");
    expect(activeTab(parseHash(routeHash("duzelt", ["v1"], { don: "#/baski/masa/s1" })))).toBe("baski");
    expect(activeTab(parseHash(routeHash("duzelt", ["v1"], { don: "#/kurulum" })))).toBe("uretim");
    expect(activeTab(parseHash("#/kurulum"))).toBeNull();
    expect(activeTab(parseHash("#/vitrin"))).toBeNull();
    expect(activeTab(parseHash("#/ayarlar/dil"))).toBe("ayarlar");
  });
});
