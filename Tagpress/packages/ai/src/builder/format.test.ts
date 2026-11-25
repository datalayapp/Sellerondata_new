import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as mcpData from "../../../../apps/mcp/src/tools/data.ts";
import * as mcpProfile from "../../../../apps/mcp/src/tools/profile.ts";
import * as mcpWork from "../../../../apps/mcp/src/tools/work.ts";
import { BADGE, formatProfile, formatProposalResult, formatReplay, formatSample, formatToolInputError, profileLeaves, type ReferenceSampleView, type ReplaySideView, schemaFields } from "./format.ts";
import { FIXTURE_PROFILE_EXTRA, FIXTURE_PROFILE_RECORD, FIXTURE_REPLAYS, FIXTURE_SAMPLES } from "./format.fixtures.ts";

/** Taşıma öncesinde (`apps/mcp/src/tools/*`) aynı girdilerle üretilmiş çıktılar. */
const golden = JSON.parse(readFileSync(new URL("./format.golden.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("biçimleyiciler (MCP'den taşındı)", () => {
  it("çıktılar taşıma öncesiyle bayt bayt aynı", () => {
    const rec = FIXTURE_PROFILE_RECORD;
    const now = {
      badge: BADGE,
      formatProfile: formatProfile(rec),
      formatProfileGroup: formatProfile(rec, "boyut"),
      formatProfileExtra: formatProfile({ ...rec, data: FIXTURE_PROFILE_EXTRA } as typeof rec),
      profileLeaves: profileLeaves(rec.data),
      schemaFields: schemaFields(),
      formatSample: FIXTURE_SAMPLES.map((s, i) => formatSample(s as ReferenceSampleView, i)),
      formatReplay: FIXTURE_REPLAYS.map((r) => formatReplay(r as { refs: number; split: string; sides: ReplaySideView[] })),
    };
    expect(JSON.parse(JSON.stringify(now))).toEqual(golden);
    expect(JSON.stringify(now, null, 1) + "\n").toBe(readFileSync(new URL("./format.golden.json", import.meta.url), "utf8").replace(/\r\n/g, "\n"));
  });

  it("MCP araçları aynı işlevleri kullanır (kopya yok)", () => {
    expect(mcpProfile.formatProfile).toBe(formatProfile);
    expect(mcpProfile.schemaFields).toBe(schemaFields);
    expect(mcpProfile.profileLeaves).toBe(profileLeaves);
    expect(mcpProfile.BADGE).toBe(BADGE);
    expect(mcpData.formatSample).toBe(formatSample);
    expect(mcpWork.formatReplay).toBe(formatReplay);
  });
});

describe("oluşturucu araç sonucu metinleri", () => {
  it("öneri sonucu: kabul, ret kodu ve sayaç", () => {
    const t = formatProposalResult({
      rev: 2,
      applied: [{ path: "sizing.fill", group: "boyut", label: "sizing.fill", unit: "oran", from: 0.9, to: 0.91, source: { kind: "measurement", ref: "fill.median", n: 12 }, warning: { code: "outside-measured-range", params: { q1: 0.92, q3: 0.95, n: 12 } } }],
      rejected: [{ index: 1, path: "name", code: "path-not-allowed" }],
      failedStreak: 1,
    });
    expect(t).toContain("Revision 2 written (1 change applied).");
    expect(t).toContain('- applied sizing.fill: 0.9 → 0.91 (source measurement fill.median, n=12) · WARNING outside-measured-range {"q1":0.92,"q3":0.95,"n":12}');
    expect(t).toContain("- REJECTED changes[1] name: path-not-allowed");
    expect(t).toContain("Consecutive failed proposals: 1/3");
    expect(formatProposalResult({ rev: null, applied: [], rejected: [], failedStreak: 0 })).toBe("No change was applied; the draft is unchanged.");
  });

  it("girdi hatası alan yollarıyla", () => {
    expect(formatToolInputError("ask_user", ["questions: 1–6 öğe."])).toBe("The input for ask_user was rejected before running the tool:\n- questions: 1–6 öğe.\nCorrect the input and call the tool again.");
  });
});
