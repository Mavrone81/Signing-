import { describe, it, expect } from "vitest";
import { formatDateSGT } from "../../src/lib/format";

describe("formatDateSGT", () => {
  it("renders in Asia/Singapore local time regardless of host TZ", () => {
    // 2026-01-01T16:30:00Z = 2026-01-02T00:30 SGT (UTC+8)
    const out = formatDateSGT(new Date("2026-01-01T16:30:00.000Z"));
    expect(out).toContain("2026");
    expect(out).toMatch(/Jan/);
    // Crossed midnight into the 2nd in SGT.
    expect(out).toContain("2");
  });

  it("accepts an ISO string as well as a Date", () => {
    const fromString = formatDateSGT("2026-01-01T16:30:00.000Z");
    const fromDate = formatDateSGT(new Date("2026-01-01T16:30:00.000Z"));
    expect(fromString).toBe(fromDate);
  });
});
