import type { PrintSlot, TemplateCut } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { groupTemplates, presetSizePatch } from "./raf.ts";

const circle = (id: string, d = 37): PrintSlot => ({ id, shape: "circle", cx: 50, cy: 50, w: d, h: d, rotation: 0, cornerRadius: 0 });
const rect = (id: string, w: number, h: number, rotation = 0): PrintSlot => ({ id, shape: "rect", cx: 50, cy: 50, w, h, rotation, cornerRadius: 0 });
const tpl = (id: string, sizeId: string | null, slots: PrintSlot[], o: { kind?: "label" | "sticker"; archived?: boolean } = {}) => ({ id, kind: o.kind ?? "label", sizeId, slots, archived: o.archived ?? false });

const urunCut: TemplateCut = { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 };
const roundCut: TemplateCut = { shape: "roundRect", wMm: 50, hMm: 30, radiusMm: 3 };
const daireCut: TemplateCut = { shape: "circle", wMm: 37, hMm: 37, radiusMm: 0 };

describe("raf grubu ↔ sayfa şablonu kesim uyumu", () => {
  const ts = [
    tpl("daire", null, [circle("s1"), circle("s2")]),
    tpl("urun", null, [rect("s1", 63.5, 38.1), rect("s2", 38.1, 63.5)]),
    tpl("karisik", null, [rect("s1", 63.5, 38.1), circle("s2")]),
    tpl("bos", null, []),
    tpl("kare", "40x40", [rect("s1", 40, 40)]),
    tpl("eski", null, [rect("s1", 63.5, 38.1)], { archived: true }),
  ];

  it("boyutu tam uyan şablon varsa yalnız o; boyutsuzlar sorulmaz (kesimli grupta da)", () => {
    expect(groupTemplates({ kind: "label", sizeId: "40x40" }, ts)).toEqual({ usable: [ts[4]], unfit: [] });
    expect(groupTemplates({ kind: "label", sizeId: "40x40", cut: { shape: "rect", wMm: 40, hMm: 40, radiusMm: 0 } }, ts)).toEqual({ usable: [ts[4]], unfit: [] });
  });

  it("kesimli grupta boyutsuz şablon yalnız bütün yuvaları uyuyorsa (dik dönmüş dikdörtgen de); uymayanlar ayrı", () => {
    const r = groupTemplates({ kind: "label", sizeId: "63.5x38.1", cut: urunCut }, ts);
    expect(r.usable.map((t) => t.id)).toEqual(["urun"]);
    expect(r.unfit.map((t) => t.id)).toEqual(["daire", "karisik", "bos"]);
  });

  it("uyan yoksa önerilecek şablon yok, uymayanlar uyarı için döner", () => {
    const r = groupTemplates({ kind: "label", sizeId: "50x30r3", cut: roundCut }, ts);
    expect(r.usable).toEqual([]);
    expect(r.unfit.map((t) => t.id)).toEqual(["daire", "urun", "karisik", "bos"]);
  });

  it("daire kesimi ('3.8' kimliği eski boyutla aynı) `cut` alanıyla ayrılır: yalnız çapı uyan daire yuvalı şablon", () => {
    const r = groupTemplates({ kind: "label", sizeId: "3.7", cut: daireCut }, ts);
    expect(r.usable.map((t) => t.id)).toEqual(["daire"]);
    expect(r.unfit.map((t) => t.id)).toEqual(["urun", "karisik", "bos"]);
    // Çap uymuyorsa (Ø38 kesim, Ø37 yuva) o da uymaz.
    expect(groupTemplates({ kind: "label", sizeId: "3.8", cut: { ...daireCut, wMm: 38, hMm: 38 } }, ts).usable).toEqual([]);
  });

  it("kesimsiz (eski) grup: boyut kimliği ne olursa olsun eski kural, boyutsuz şablonların hepsi (sunucu gibi)", () => {
    for (const sizeId of ["3.8", "4", null, "63.5x38.1"]) {
      const r = groupTemplates({ kind: "label", sizeId }, ts);
      expect(r.usable.map((t) => t.id)).toEqual(["daire", "urun", "karisik", "bos"]);
      expect(r.unfit).toEqual([]);
    }
  });

  it("sticker grubu kesime bakmaz; tür ve arşiv süzülür", () => {
    expect(groupTemplates({ kind: "sticker", sizeId: "B", cut: urunCut }, [tpl("serbest", null, [], { kind: "sticker" })]).usable.map((t) => t.id)).toEqual(["serbest"]);
    const st = [tpl("a", "A", [], { kind: "sticker" }), tpl("serbest", null, [], { kind: "sticker" })];
    expect(groupTemplates({ kind: "sticker", sizeId: "A" }, [...ts, ...st]).usable.map((t) => t.id)).toEqual(["a"]);
    expect(groupTemplates({ kind: "sticker", sizeId: "B" }, [...ts, ...st]).usable.map((t) => t.id)).toEqual(["serbest"]);
  });
});

describe("hazır ayardan ızgara: boyut kimliği", () => {
  const urun = { kind: "label" as const, sizeId: "63.5x38.1", labelDiameterMm: null };
  const daire = { kind: "label" as const, sizeId: null, labelDiameterMm: null };
  const rects = [rect("s1", 63.5, 38.1), rect("s2", 63.5, 38.1)];

  it("hazır ayarın kesim kimliği, yuvalar uyuyorsa yazılır", () => {
    expect(presetSizePatch(urun, { kind: "label", sizeId: null }, rects)).toEqual({ sizeId: "63.5x38.1" });
  });

  it("kullanıcı yuva ölçüsünü değiştirdiyse kesim kimliği yazılmaz", () => {
    expect(presetSizePatch(urun, { kind: "label", sizeId: null }, [rect("s1", 70, 38.1)])).toEqual({});
  });

  it("boyutsuz hazır ayar: şablonun kesim kimliği yeni yuvalara uymuyorsa boşaltılır, eski boyut kimliğine dokunulmaz", () => {
    expect(presetSizePatch(daire, { kind: "label", sizeId: "63.5x38.1" }, [circle("s1")])).toEqual({ sizeId: null });
    expect(presetSizePatch(daire, { kind: "label", sizeId: "63.5x38.1" }, rects)).toEqual({});
    expect(presetSizePatch(daire, { kind: "label", sizeId: "3.8" }, [circle("s1")])).toEqual({});
  });

  it("eski boyut kimliği ve etiket çapı olduğu gibi yazılır; tür farklıysa ya da hazır ayar yoksa hiçbir şey", () => {
    expect(presetSizePatch({ kind: "label", sizeId: "3.8", labelDiameterMm: 38 }, { kind: "label", sizeId: null }, [circle("s1")])).toEqual({ sizeId: "3.8", labelDiameterMm: 38 });
    expect(presetSizePatch(urun, { kind: "sticker", sizeId: null }, rects)).toEqual({});
    expect(presetSizePatch(null, { kind: "label", sizeId: null }, rects)).toEqual({});
  });
});
