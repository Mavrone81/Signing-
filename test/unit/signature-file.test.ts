import { describe, it, expect } from "vitest";
import { isSupportedSignatureImage } from "../../src/lib/signature-file";

describe("isSupportedSignatureImage", () => {
  it("accepts a PNG file", () => {
    expect(isSupportedSignatureImage({ type: "image/png" })).toBe(true);
  });

  it("accepts a JPEG file", () => {
    expect(isSupportedSignatureImage({ type: "image/jpeg" })).toBe(true);
  });

  it("accepts the legacy image/jpg type some browsers report", () => {
    expect(isSupportedSignatureImage({ type: "image/jpg" })).toBe(true);
  });

  it("rejects a PDF", () => {
    expect(isSupportedSignatureImage({ type: "application/pdf" })).toBe(false);
  });

  it("rejects an unknown/empty type", () => {
    expect(isSupportedSignatureImage({ type: "" })).toBe(false);
  });
});
