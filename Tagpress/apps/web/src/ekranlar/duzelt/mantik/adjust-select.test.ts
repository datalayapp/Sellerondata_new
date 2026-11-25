import "../../../i18n/test.ts";
import { adjustedInk, adjustedLineInks, boxCenter, IDENTITY_ADJUST, type VariantAdjust } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import {
  blockMat,
  centerSelection,
  composeMat,
  cornerPoint,
  cycleSel,
  dragSelection,
  handleScale,
  hitLine,
  lineAdjustOf,
  lineMat,
  lineTransformAttr,
  mapBoxBy,
  nudgeSelection,
  scaleSelectionAbout,
  selectionBox,
  selectionName,
  setLineAdjust,
  shiftSelection,
  snapSelection,
  stepSelectionScale,
  stepSelectionStroke,
  selIndices,
  toggleSel,
  marqueeSel,
  marqueeHits,
  selectedLines,
  singleLine,
  selectionScale,
  selectionStroke,
} from "./adjust-select.ts";

const lines = [
  { ink: { x: 120, y: 160, w: 200, h: 30 } },
  { ink: { x: 150, y: 196, w: 140, h: 40 } },
  { ink: { x: 170, y: 242, w: 100, h: 24 } },
];
const layout = { ink: { x: 120, y: 160, w: 200, h: 106 }, lines };
const centers = { textCenter: { x: 220, y: 220 }, area: { x: 220, y: 220 }, cut: { x: 220, y: 220 } };
const near = (a: number, b: number, d = 0.02) => expect(Math.abs(a - b)).toBeLessThanOrEqual(d);
const nearBox = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
  near(a.x, b.x);
  near(a.y, b.y);
  near(a.w, b.w);
  near(a.h, b.h);
};

const mixed: VariantAdjust = {
  dx: 12,
  dy: -7,
  scale: 1.1,
  lines: [
    { index: 0, dx: 5, dy: 3, scale: 0.9 },
    { index: 2, dx: -8, dy: 1.5, scale: 1.2 },
  ],
};

describe("istemci dönüşümü = domain dönüşümü", () => {
  it("blok ∘ satır matrisi, domain adjustedLineInks ile aynı kutuyu verir", () => {
    const want = adjustedLineInks(layout, mixed);
    lines.forEach((l, i) => {
      const m = composeMat(blockMat(layout, mixed), lineMat(l.ink, lineAdjustOf(mixed, i)));
      nearBox(mapBoxBy(m, l.ink), want[i]!);
    });
  });
  it("satır düzeltmesi olmayan satır yalnızca blok dönüşümünü alır", () => {
    const m = composeMat(blockMat(layout, mixed), lineMat(lines[1]!.ink, lineAdjustOf(mixed, 1)));
    nearBox(mapBoxBy(m, lines[1]!.ink), adjustedLineInks(layout, mixed)[1]!);
  });
  it("SVG öznitelik metni matristir", () => {
    expect(lineTransformAttr({ x: 0, y: 0, w: 100, h: 20 }, { dx: 4, dy: -2, scale: 1.5 })).toBe("matrix(1.5 0 0 1.5 -21 -7)");
  });
});

describe("taşıma", () => {
  it("satır sürüklemesi blok ölçeğinde bile imleci tam izler", () => {
    const start: VariantAdjust = { dx: 0, dy: 0, scale: 1.25 };
    const before = selectionBox(layout, start, 1);
    const next = dragSelection(start, 1, 20, -10, 0.5); // ekran 20/-10 px, k=0,5 → tasarım 40/-20
    const after = selectionBox(layout, next, 1);
    near(after.x - before.x, 40);
    near(after.y - before.y, -20);
    // diğer satırlar yerinde
    nearBox(selectionBox(layout, next, 0), selectionBox(layout, start, 0));
  });
  it("blok sürüklemesi satır düzeltmelerini korur", () => {
    const next = shiftSelection(mixed, null, 3, 4);
    expect(next.dx).toBe(15);
    expect(next.lines).toEqual(mixed.lines);
  });
  it("ok tuşu seçili satırı 1 px, Shift ile 10 px oynatır", () => {
    const b0 = selectionBox(layout, mixed, 2);
    near(selectionBox(layout, nudgeSelection(mixed, 2, "ArrowRight", false), 2).x - b0.x, 1);
    near(selectionBox(layout, nudgeSelection(mixed, 2, "ArrowDown", true), 2).y - b0.y, 10);
  });
  it("kimliğe dönen satır listeden çıkar", () => {
    const a = setLineAdjust({ dx: 0, dy: 0, scale: 1, lines: [{ index: 1, dx: 4, dy: 0, scale: 1 }] }, { index: 1, dx: 0, dy: 0, scale: 1 });
    expect(a.lines).toBeUndefined();
  });
  it("±500 sınırı", () => {
    expect(shiftSelection(IDENTITY_ADJUST, 0, 9999, 0).lines?.[0]?.dx).toBe(500);
  });
});

describe("ortalama", () => {
  it("satır merkezi hedefe oturur (iki eksen), diğer satırlar kıpırdamaz", () => {
    const next = centerSelection(layout, centers, mixed, 1, { axis: "both", target: "textCenter" });
    const c = boxCenter(selectionBox(layout, next, 1));
    near(c.x, 220);
    near(c.y, 220);
    nearBox(selectionBox(layout, next, 0), selectionBox(layout, mixed, 0));
  });
  it("yatay ortalama yalnızca x", () => {
    const before = boxCenter(selectionBox(layout, mixed, 0));
    const c = boxCenter(selectionBox(layout, centerSelection(layout, centers, mixed, 0, { axis: "x", target: "textCenter" }), 0));
    near(c.x, 220);
    near(c.y, before.y);
  });
  it("bütün yazı seçiliyken domain ortalaması", () => {
    const c = boxCenter(adjustedInk(layout, centerSelection(layout, centers, mixed, null, { axis: "both", target: "textCenter" })));
    near(c.x, 220);
    near(c.y, 220);
  });
  it("yapışma menzilinde satır merkezi hedefe oturur", () => {
    const start = centerSelection(layout, centers, mixed, 1, { axis: "both", target: "textCenter" });
    const moved = shiftSelection(start, 1, 2, 9);
    const snapped = snapSelection(layout, moved, 1, centers.textCenter, 4);
    const c = boxCenter(selectionBox(layout, snapped, 1));
    near(c.x, 220);
    near(c.y, boxCenter(selectionBox(layout, moved, 1)).y); // dikey menzil dışı
  });
});

describe("boyut", () => {
  it("satır boyutu +%2: yalnızca o satırın ölçeği, merkezi sabit", () => {
    const before = selectionBox(layout, mixed, 1);
    const next = stepSelectionScale(layout, mixed, 1, 0.02);
    expect(lineAdjustOf(next, 1).scale).toBeCloseTo(1.02, 4);
    expect(next.scale).toBe(mixed.scale);
    const after = selectionBox(layout, next, 1);
    near(boxCenter(after).x, boxCenter(before).x);
    near(boxCenter(after).y, boxCenter(before).y);
    near(after.w / before.w, 1.02, 0.001);
  });
  it("satır ölçeği 0,5–1,5 sınırında durur", () => {
    let a: VariantAdjust = IDENTITY_ADJUST;
    for (let i = 0; i < 40; i++) a = stepSelectionScale(layout, a, 0, -0.02);
    expect(lineAdjustOf(a, 0).scale).toBe(0.5);
  });
  it("bütün yazı boyutu domain stepScale", () => {
    expect(stepSelectionScale(layout, IDENTITY_ADJUST, null, 0.02).scale).toBe(1.02);
  });
  it("sabit nokta ölçekten sonra yerinde kalır (satır)", () => {
    const box = selectionBox(layout, mixed, 2);
    const anchor = cornerPoint(box, "nw");
    const next = scaleSelectionAbout(layout, mixed, 2, 1.4, anchor);
    const nb = selectionBox(layout, next, 2);
    near(nb.x, anchor.x);
    near(nb.y, anchor.y);
    near(nb.w / box.w, 1.4 / 1.2, 0.001);
  });
  it("sabit nokta ölçekten sonra yerinde kalır (bütün yazı)", () => {
    const box = selectionBox(layout, mixed, null);
    const anchor = cornerPoint(box, "se");
    const nb = selectionBox(layout, scaleSelectionAbout(layout, mixed, null, 0.8, anchor), null);
    near(nb.x + nb.w, anchor.x);
    near(nb.y + nb.h, anchor.y);
  });
  it("köşe tutamacı: karşı köşe sabit, orantılı büyür", () => {
    const box = selectionBox(layout, mixed, 1);
    const C = cornerPoint(box, "se");
    const A = cornerPoint(box, "nw");
    const pointer = { x: A.x + (C.x - A.x) * 1.3, y: A.y + (C.y - A.y) * 1.3 };
    const next = handleScale(layout, mixed, 1, "se", pointer);
    const nb = selectionBox(layout, next, 1);
    near(nb.x, A.x);
    near(nb.y, A.y);
    near(nb.w / box.w, 1.3, 0.002);
    near(nb.h / box.h, 1.3, 0.002);
  });
});

describe("seçim yardımcıları", () => {
  it("ad", () => {
    expect(selectionName(null, [])).toBe("Bütün yazı");
    expect(selectionName(1, [{ text: "A" }, { text: "Matteo" }])).toBe("Satır 2: Matteo");
  });
  it("Tab sırası döner", () => {
    expect(cycleSel(null, 3, false)).toEqual([0]);
    expect(cycleSel(2, 3, false)).toBeNull();
    expect(cycleSel(null, 3, true)).toEqual([2]);
    expect(cycleSel(0, 3, true)).toBeNull();
    // Çoklu seçimden: ileri son satırdan, geri ilk satırdan.
    expect(cycleSel([0, 1], 3, false)).toEqual([2]);
    expect(cycleSel([1, 2], 3, true)).toEqual([0]);
  });
  it("tıklama: kutunun içi satırı bulur, dışı null; üst üste binende küçük kutu", () => {
    expect(hitLine(layout, IDENTITY_ADJUST, { x: 200, y: 175 }, 0)).toBe(0);
    expect(hitLine(layout, IDENTITY_ADJUST, { x: 200, y: 215 }, 0)).toBe(1);
    expect(hitLine(layout, IDENTITY_ADJUST, { x: 20, y: 20 }, 3)).toBeNull();
    expect(hitLine(layout, IDENTITY_ADJUST, { x: 200, y: 193 }, 4)).not.toBeNull();
  });
  it("tıklama taşınmış satırı yeni yerinde bulur", () => {
    const a = shiftSelection(IDENTITY_ADJUST, 0, 0, 100);
    expect(hitLine(layout, a, { x: 200, y: 275 }, 0)).toBe(0);
  });
});

describe("çoklu seçim", () => {
  it("seçim biçimi: sıralı, tekrarsız, geçersiz satır atılır; boşsa bütün yazı", () => {
    expect(selIndices([2, 0, 2, 9], 3)).toEqual([0, 2]);
    expect(selIndices([], 3)).toBeNull();
    expect(selIndices(1, 3)).toEqual([1]);
    expect(selectedLines(null, 3)).toEqual([0, 1, 2]);
    expect(singleLine([1], 3)).toBe(1);
    expect(singleLine([0, 1], 3)).toBeNull();
    expect(selectionName([0, 2], [{ text: "A" }, { text: "B" }, { text: "C" }])).toBe("2 satır: 1, 3");
  });
  it("Ctrl/Shift + tık: bütün yazıdan tek satıra, sonra ekle/çıkar; son satır çıkınca bütün yazı", () => {
    let sel = toggleSel(null, 1, 3);
    expect(sel).toEqual([1]);
    sel = toggleSel(sel, 0, 3);
    expect(sel).toEqual([0, 1]);
    sel = toggleSel(sel, 1, 3);
    expect(sel).toEqual([0]);
    expect(toggleSel(sel, 0, 3)).toBeNull();
  });
  it("seçim kutusu: kesişen satırlar; Ctrl ile eklenir; hiçbiri yoksa bütün yazı", () => {
    expect(marqueeHits(layout, IDENTITY_ADJUST, { x: 100, y: 150, w: 300, h: 50 })).toEqual([0, 1]);
    expect(marqueeHits(layout, IDENTITY_ADJUST, { x: 0, y: 0, w: 10, h: 10 })).toBeNull();
    expect(marqueeSel(layout, IDENTITY_ADJUST, { x: 160, y: 250, w: 10, h: 5 }, [0], true)).toEqual([0, 2]);
    expect(marqueeSel(layout, IDENTITY_ADJUST, { x: 160, y: 250, w: 10, h: 5 }, [0], false)).toEqual([2]);
  });
  it("seçim kutusu (birleşim) ve birlikte taşıma: seçilmeyen satır yerinde", () => {
    const box = selectionBox(layout, mixed, [0, 2]);
    const inks = adjustedLineInks(layout, mixed);
    near(box.x, Math.min(inks[0]!.x, inks[2]!.x));
    near(box.y + box.h, inks[2]!.y + inks[2]!.h);
    const moved = shiftSelection(mixed, [0, 2], 10, -4);
    const after = adjustedLineInks(layout, moved);
    near(after[0]!.x - inks[0]!.x, 10);
    near(after[2]!.y - inks[2]!.y, -4);
    nearBox(after[1]!, inks[1]!);
    // Ok tuşu ince adımla (0,25 px).
    const n = nudgeSelection(mixed, [0, 2], "ArrowLeft", false, 0.25);
    near(adjustedLineInks(layout, n)[0]!.x - inks[0]!.x, -0.25);
    near(adjustedLineInks(layout, n)[2]!.x - inks[2]!.x, -0.25);
  });
  it("çoklu ortalama: grubun merkezi hedefe oturur, satırlar arası düzen korunur", () => {
    const next = centerSelection(layout, centers, mixed, [0, 1], { axis: "both", target: "textCenter" });
    const c = boxCenter(selectionBox(layout, next, [0, 1]));
    near(c.x, 220);
    near(c.y, 220);
    const a0 = adjustedLineInks(layout, mixed);
    const a1 = adjustedLineInks(layout, next);
    near(a1[1]!.x - a1[0]!.x, a0[1]!.x - a0[0]!.x);
    nearBox(a1[2]!, a0[2]!);
  });
  it("çoklu boyut: grup orantılı büyür, merkezi sabit; köşe tutamacında karşı köşe sabit", () => {
    const before = selectionBox(layout, mixed, [0, 1]);
    const next = stepSelectionScale(layout, mixed, [0, 1], 0.09); // ilk satır 0,9 → 0,99: oran 1,1
    const after = selectionBox(layout, next, [0, 1]);
    near(boxCenter(after).x, boxCenter(before).x);
    near(boxCenter(after).y, boxCenter(before).y);
    near(after.w / before.w, 1.1, 0.002);
    expect(selectionScale(next, [0, 1])).toBeCloseTo(0.99, 4);
    expect(lineAdjustOf(next, 1).scale).toBeCloseTo(1.1, 4);
    const C = cornerPoint(before, "se");
    const A = cornerPoint(before, "nw");
    const h = handleScale(layout, mixed, [0, 1], "se", { x: A.x + (C.x - A.x) * 1.2, y: A.y + (C.y - A.y) * 1.2 });
    const hb = selectionBox(layout, h, [0, 1]);
    near(hb.x, A.x);
    near(hb.y, A.y);
    near(hb.w / before.w, 1.2, 0.003);
  });
  it("çoklu kalınlık: her seçili satıra eklenir", () => {
    const next = stepSelectionStroke(mixed, [0, 2], 0.2);
    expect(lineAdjustOf(next, 0).strokePx).toBe(0.2);
    expect(lineAdjustOf(next, 2).strokePx).toBe(0.2);
    expect(lineAdjustOf(next, 1).strokePx).toBeUndefined();
    expect(selectionStroke(next, [0, 2])).toBe(0.2);
  });
  it("origin verilirse blok ölçeği onun etrafında (düzenlenmiş satırlarda blok kaymaz)", () => {
    const withOrigin = { ...layout, origin: { x: 220, y: 213 } };
    const a: VariantAdjust = { dx: 0, dy: 0, scale: 1.5 };
    const b = selectionBox(withOrigin, a, null);
    const c = boxCenter(b);
    const c0 = boxCenter(layout.ink);
    near(c.x, 220 + 1.5 * (c0.x - 220));
    near(c.y, 213 + 1.5 * (c0.y - 213));
  });
});
