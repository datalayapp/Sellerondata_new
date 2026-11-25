import { describe, expect, it } from "vitest";
import { formatUsd } from "./format.ts";

describe("formatUsd", () => {
  it("Türkçe biçim", () => {
    expect(formatUsd(0)).toBe("$0,00");
    expect(formatUsd(0.006)).toBe("$0,006");
    expect(formatUsd(0.0042)).toBe("$0,0042");
    expect(formatUsd(0.125)).toBe("$0,125");
    expect(formatUsd(1.25)).toBe("$1,25");
    expect(formatUsd(1234.5)).toBe("$1.234,50");
  });
  it("yaklaşık ve boş değer", () => {
    expect(formatUsd(0.006, { approx: true })).toBe("~$0,006");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });
});
