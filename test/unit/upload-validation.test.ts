import { describe, it, expect } from "vitest";
import {
  isLikelyPdf,
  isUnderClientSizeCap,
  CLIENT_MAX_UPLOAD_MB,
} from "../../src/lib/upload-validation";

describe("isLikelyPdf", () => {
  it("accepts a .pdf name with application/pdf type", () => {
    expect(isLikelyPdf({ name: "contract.pdf", type: "application/pdf" })).toBe(true);
  });

  it("accepts a .pdf name with no type (some browsers omit it)", () => {
    expect(isLikelyPdf({ name: "contract.pdf", type: "" })).toBe(true);
  });

  it("is case-insensitive on extension", () => {
    expect(isLikelyPdf({ name: "CONTRACT.PDF", type: "application/pdf" })).toBe(true);
  });

  it("rejects a non-pdf extension", () => {
    expect(isLikelyPdf({ name: "contract.docx", type: "application/pdf" })).toBe(false);
  });

  it("rejects a mismatched mime type even with a .pdf name", () => {
    expect(isLikelyPdf({ name: "contract.pdf", type: "image/png" })).toBe(false);
  });
});

describe("isUnderClientSizeCap", () => {
  it("accepts a file at or under the cap", () => {
    expect(isUnderClientSizeCap({ size: CLIENT_MAX_UPLOAD_MB * 1024 * 1024 })).toBe(true);
  });

  it("rejects a file over the cap", () => {
    expect(isUnderClientSizeCap({ size: CLIENT_MAX_UPLOAD_MB * 1024 * 1024 + 1 })).toBe(false);
  });

  it("honors a custom cap", () => {
    expect(isUnderClientSizeCap({ size: 10 * 1024 * 1024 }, 5)).toBe(false);
  });
});
