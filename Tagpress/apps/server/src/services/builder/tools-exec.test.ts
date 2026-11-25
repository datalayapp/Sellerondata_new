import { type BuildEntry, type ProposeChangesInput, defaultProfile } from "@tagpress/domain";
import type { StyleMeasurement } from "@tagpress/learn";
import { describe, expect, it } from "vitest";
import { BuildStreams } from "./stream.ts";
import { checkProposal, measurementText, resolveMeasurement } from "./tools-exec.ts";

const compact = (n: number, median: number, q1: number, q3: number) => ({ n, median, q1, q3, p10: q1, p90: q3 });

/** Ölçüm özetinin testte gereken kısmı (gerisi boş). */
const M = {
  refs: { total: 12, usable: 12, train: 12, test: 0, withImage: 0, withProgram: 0, otherFrame: 0, uploaded: { total: 0, exact: 0, ink: 0, none: 0, approx: 0, sizesUnknown: 0 } },
  lineCount: [{ lines: 2, count: 8 }],
  lineLength: { p50: 12, p90: 18, max: 24, longest: [] },
  ratios: { secondary: compact(10, 0.62, 0.55, 0.68), tertiary: null, connector: compact(0, 0, 0, 0), byConnector: { "&": compact(6, 0.4, 0.35, 0.45) }, glyphs: {} },
  gaps: { normal: compact(9, 0.2, 0.15, 0.25), beforeLast: null, connector: null, approxExcluded: {}, withApprox: {} },
  fill: { largestPx: null, blockWidthOfCut: null, blockHeightOfCut: null },
  fonts: { byLabel: [], byLine: [], mixedLabels: 0, glyphSegments: [] },
  connectors: { standalone: [], inline: [], stackedLabels: 0, inlineLabels: 0, shiftEm: null },
  examples: [],
  uppercase: { labels: 0, fonts: [], examples: [] },
  longText: { labels: 0, threshold: 40, lineCount: [], fonts: [], examples: [] },
  templates: [],
  programVsUser: { compared: 0, sameBreaks: 0, scale: null, separatorsOnly: 0, textEdited: 0, fontChanges: [] },
  findings: ["Bulgu"],
} as unknown as StyleMeasurement;

const entry = (id: number): BuildEntry => ({ id, at: "", role: "user", kind: "answer", turnSeq: 1, text: "x", group: null });
const env = (measurement: StyleMeasurement | null = M) => ({ draft: defaultProfile("Deneme"), measurement, userEntry: (id: number) => (id === 7 ? entry(7) : null) });
const one = (c: ProposeChangesInput["changes"][number]): ProposeChangesInput => ({ note: "n", changes: [c] });

describe("ölçüm anahtarı", () => {
  it("istatistik düzeyinde ve altındaki yaprakta çözülür; boş, n=0 ya da bilinmeyen anahtar kanıt değildir", () => {
    expect(resolveMeasurement(M, "ratios.secondary")).toMatchObject({ n: 10, q1: 0.55, q3: 0.68 });
    expect(resolveMeasurement(M, "ratios.secondary.median")).toMatchObject({ value: 0.62, n: 10 });
    expect(resolveMeasurement(M, "ratios.byConnector.&")).toMatchObject({ n: 6 });
    // Satır uzunluğunun n'si metni ölçülen etiket sayısıdır (satır sayısı dağılımının toplamı), bütün referanslar değil.
    expect(resolveMeasurement(M, "lineLength.p90")).toMatchObject({ value: 18, n: 8 });
    expect(resolveMeasurement(M, "ratios.tertiary")).toBeNull();
    expect(resolveMeasurement(M, "ratios.connector")).toBeNull();
    expect(resolveMeasurement(M, "examples")).toBeNull();
    expect(resolveMeasurement(M, "ratios.yok")).toBeNull();
    expect(resolveMeasurement(M, "__proto__")).toBeNull();
    expect(resolveMeasurement(null, "ratios.secondary")).toBeNull();
    expect(measurementText(M)).toContain("Findings:\n- Bulgu");
    expect(measurementText(null)).toBe("");
  });

  it("yalnız istatistik kanıt sayılır: sayım, liste, örnek metin, bulgu ve program karşılaştırması `unknown-measurement` (B1)", () => {
    const m = {
      ...M,
      refs: { ...M.refs, uploaded: { total: 3, exact: 0, ink: 3, none: 0, approx: 0, sizesUnknown: 0 } },
      lineLength: { p50: 12, p90: 18, max: 24, longest: ["Ayşe & Mehmet"] },
      examples: [{ text: "Ayşe & Mehmet", lines: ["Ayşe", "& Mehmet"], fonts: [], template: null }],
      fonts: { byLabel: [{ key: "Hayal", count: 8, share: 0.8 }], byLine: [], mixedLabels: 0, glyphSegments: [] },
      connectors: { standalone: [], inline: [], stackedLabels: 0, inlineLabels: 0, shiftEm: compact(5, 0.1, 0.05, 0.15) },
      programVsUser: { compared: 4, sameBreaks: 2, scale: compact(4, 1.1, 1, 1.2), separatorsOnly: 0, textEdited: 0, fontChanges: [] },
    } as unknown as StyleMeasurement;
    const denied = [
      "refs.usable",
      "refs.uploaded.total",
      "refs",
      "findings.0",
      "findings",
      "lineLength.longest.0",
      "lineLength.longest",
      "lineLength",
      "lineCount.0",
      "lineCount.0.count",
      "examples.0.text",
      "fonts.byLabel.0.share",
      "programVsUser.scale",
      "programVsUser.scale.median",
      "programVsUser.compared",
      "ratios.secondary.n",
      "ratios.secondary.median.x",
      "ratios",
    ];
    for (const key of denied) {
      expect(resolveMeasurement(m, key), key).toBeNull();
      const r = checkProposal(one({ path: "sizing.tiers.secondary", value_json: "0.95", evidence: { kind: "measurement", key } }), { ...env(), measurement: m });
      expect(r.rejected.map((x) => x.code), key).toEqual(["unknown-measurement"]);
      expect(r.profile, key).toBeNull();
    }
    // İzin listesi: istatistik düğümü, yaprağı ve satır uzunluğu yüzdelikleri.
    for (const key of ["ratios.secondary", "ratios.secondary.median", "ratios.secondary.p90", "gaps.normal.q1", "connectors.shiftEm", "lineLength.p50", "lineLength.p90", "lineLength.max"]) {
      expect(resolveMeasurement(m, key), key).not.toBeNull();
    }
    // Ölçülmemiş yüzdelik (boş kümede NaN → JSON null) kanıt değildir: uydurma değer yazılmaz.
    const empty = { ...m, lineCount: [], lineLength: { p50: Number.NaN, p90: Number.NaN, max: 0, longest: [] } } as unknown as StyleMeasurement;
    expect(resolveMeasurement(empty, "lineLength.p90")).toBeNull();
    expect(resolveMeasurement(empty, "lineLength.max")).toBeNull();
  });
});

describe("öneri denetimi (uydurma değer yazılmaz)", () => {
  it("ölçüm kanıtı: n ölçümden yazılır (modelinki yok sayılır); çeyrekler dışı kabul edilir ama uyarı alır", () => {
    const ok = checkProposal(one({ path: "sizing.tiers.secondary", value_json: "0.6", evidence: { kind: "measurement", key: "ratios.secondary", n: 999 } }), env());
    expect(ok.rejected).toEqual([]);
    expect(ok.applied).toEqual([expect.objectContaining({ path: "sizing.tiers.secondary", to: 0.6, source: { kind: "measurement", ref: "ratios.secondary", n: 10 } })]);
    expect(ok.applied[0]!.warning).toBeUndefined();
    const out = checkProposal(one({ path: "sizing.tiers.secondary", value_json: "0.8", evidence: { kind: "measurement", key: "ratios.secondary" } }), env());
    expect(out.applied[0]!.warning).toEqual({ code: "outside-measured-range", params: { q1: 0.55, q3: 0.68, n: 10 } });
  });

  it("ölçüm yoksa ölçüm kanıtı reddedilir; başka oturumun / olmayan girdi reddedilir; cevap kanıtı kabul edilir", () => {
    expect(checkProposal(one({ path: "sizing.tiers.secondary", value_json: "0.6", evidence: { kind: "measurement", key: "ratios.secondary" } }), env(null)).rejected).toEqual([
      { index: 0, path: "sizing.tiers.secondary", code: "unknown-measurement", params: { key: "ratios.secondary" } },
    ]);
    expect(checkProposal(one({ path: "lineBreaking.maxLines", value_json: "3", evidence: { kind: "answer", entryId: 8 } }), env()).rejected[0]!.code).toBe("unknown-entry");
    const r = checkProposal(one({ path: "lineBreaking.maxLines", value_json: "3", evidence: { kind: "correction", entryId: 7 } }), env());
    expect(r.applied[0]!.source).toEqual({ kind: "correction", ref: "7" });
    expect(r.profile!.lineBreaking.maxLines).toBe(3);
  });

  it("yazılamayan yol, bozuk JSON, değerli varsayılan, şema dışı değer, değişmeyen değer reddedilir; kabul edilenler sırayla birikir", () => {
    const r = checkProposal(
      {
        note: "n",
        changes: [
          { path: "name" as never, value_json: '"X"', evidence: { kind: "answer", entryId: 7 } },
          { path: "lineBreaking.maxLines", value_json: "{bozuk", evidence: { kind: "answer", entryId: 7 } },
          { path: "lineBreaking.maxLines", value_json: "4", evidence: { kind: "default" } },
          { path: "lineBreaking.maxLines", value_json: "-2", evidence: { kind: "answer", entryId: 7 } },
          { path: "lineBreaking.maxLines", value_json: "4", evidence: { kind: "answer", entryId: 7 } },
          { path: "lineBreaking.maxLines", value_json: "4", evidence: { kind: "answer", entryId: 7 } },
          { path: "lineBreaking.maxLines", value_json: "null", evidence: { kind: "default" } },
        ],
      },
      env(),
    );
    expect(r.rejected.map((x) => [x.index, x.code])).toEqual([
      [0, "path-not-allowed"],
      [1, "invalid-json"],
      [2, "default-not-null"],
      [3, "schema-invalid"],
      [5, "no-change"],
    ]);
    // 4 → 4 uygulandı, sonra varsayılana (6) döndü.
    expect(r.applied.map((a) => [a.path, a.from, a.to])).toEqual([
      ["lineBreaking.maxLines", 6, 4],
      ["lineBreaking.maxLines", 4, 6],
    ]);
    expect(r.applied[1]!.source).toEqual({ kind: "default", ref: null });
  });

  it("satır bölme örneği: satırlar birleşince müşteri metni harfi harfine aynı değilse reddedilir (büyük harf, sembol, harf)", () => {
    const ex = (lines: string[]) => one({ path: "lineBreaking.examples", value_json: JSON.stringify([{ text: "Ayşe & Mehmet ♥", lines }]), evidence: { kind: "answer", entryId: 7 } });
    expect(checkProposal(ex(["Ayşe", "& Mehmet ♥"]), env()).rejected).toEqual([]);
    for (const bad of [["Ayse", "& Mehmet ♥"], ["AYŞE", "& Mehmet ♥"], ["Ayşe", "& Mehmet"], ["Ayşe", "ve Mehmet ♥"]]) {
      expect(checkProposal(ex(bad), env()).rejected[0], bad.join("/")).toMatchObject({ code: "text-not-preserved" });
    }
  });
});

describe("oturum akışı: kaldığı yerden", () => {
  const status = { type: "status" as const, state: "drafting" as const, resumeState: null, running: true, lastEntryId: 0 };
  it("aynı açılışın kimliğiyle kaçırılan olaylar sırayla; başka açılış ya da tampondan düşmüş kimlik anlık görüntü ister", () => {
    const s = new BuildStreams("boot1");
    const ids = [1, 2, 3].map(() => s.publish("b", status).id);
    expect(ids).toEqual(["boot1:1", "boot1:2", "boot1:3"]);
    const seen: string[] = [];
    const sub = s.subscribe("b", "boot1:1", (i) => seen.push(i.id));
    expect(sub.resumed).toBe(true);
    expect(sub.replay.map((i) => i.id)).toEqual(["boot1:2", "boot1:3"]);
    s.publish("b", status);
    expect(seen).toEqual(["boot1:4"]);
    sub.off();
    expect(s.subscribe("b", "boot1:4", () => undefined)).toMatchObject({ resumed: true, replay: [] });
    expect(s.subscribe("b", "eski:2", () => undefined).resumed).toBe(false);
    expect(s.subscribe("b", "boot1:99", () => undefined).resumed).toBe(false);
    expect(s.subscribe("b", "bozuk", () => undefined).resumed).toBe(false);
    expect(s.subscribe("b", null, () => undefined).resumed).toBe(false);
    // Başka oturumun olayları karışmaz.
    expect(s.subscribe("c", "boot1:1", () => undefined).resumed).toBe(false);
  });

  it("tampon dolunca en eski olaylar düşer; düşmüş kimlikle bağlanan anlık görüntü ister", () => {
    const s = new BuildStreams("b2");
    for (let i = 0; i < 520; i++) s.publish("x", status);
    expect(s.buffered("x")).toHaveLength(500);
    expect(s.subscribe("x", "b2:5", () => undefined).resumed).toBe(false);
    expect(s.subscribe("x", "b2:20", () => undefined)).toMatchObject({ resumed: true });
    expect(s.subscribe("x", "b2:20", () => undefined).replay).toHaveLength(500);
  });
});
