import { describe, expect, it } from "vitest";
import "../../../i18n/test.ts";
import { readAdjustEvidence, readEvidence, shiftText } from "./learnRead.ts";

describe("öğrenme önerisi okuma: elle düzeltme kanıtı", () => {
  const evidence = {
    source: "learn-run",
    origin: "adjust",
    count: 7,
    stats: {
      source: "adjust",
      samples: 7,
      jobs: 5,
      x: { medianPx: 12.4, iqrPx: 2, agreement: 0.8, systematic: true },
      y: { medianPx: -3, iqrPx: 9, agreement: 0.4, systematic: false },
      loggedErrorPx: { median: 13.1 },
      usage: { approved: 20, adjusted: 5 },
    },
    heldOut: { n: 7, before: { positionError: 13.2, sizeError: 0.01 }, after: { positionError: 2.1, sizeError: 0.01 }, folds: 5 },
    variants: [{ variantId: "v1", jobId: "j1", url: "/api/variants/v1/preview.png?v=1.1" }, { variantId: 3 }],
    weak: false,
  };

  it("elle düzeltme kanıtını okur; Figma kaynaklı kanıtta null", () => {
    const a = readAdjustEvidence(evidence)!;
    expect(a).toMatchObject({ samples: 7, jobs: 5, loggedErrorPx: 13.1, usage: { approved: 20, adjusted: 5 }, folds: 5 });
    expect(a.variants).toEqual([{ variantId: "v1", url: "/api/variants/v1/preview.png?v=1.1" }]);
    expect(shiftText(a)).toBe("12 px sağa");
    expect(readAdjustEvidence({ ...evidence, origin: "reference" })).toBeNull();
    // Önce/sonra ölçüleri genel okuyucudan gelir.
    expect(readEvidence(evidence).heldOut.map((m) => m.key)).toEqual(["positionError", "sizeError"]);
  });
});
