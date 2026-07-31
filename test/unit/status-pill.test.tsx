import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill } from "../../src/components/ui/StatusPill";

describe("StatusPill", () => {
  it("renders a draft document with a warn tone and Draft label", () => {
    const html = renderToStaticMarkup(<StatusPill status="draft" />);
    expect(html).toContain("Draft");
    expect(html).toContain("text-warn");
  });

  it("renders a signed document with a success tone and Signed label", () => {
    const html = renderToStaticMarkup(<StatusPill status="signed" />);
    expect(html).toContain("Signed");
    expect(html).toContain("text-good");
  });

  it("falls back to a neutral tone and the raw status for unknown values", () => {
    const html = renderToStaticMarkup(<StatusPill status="weird" />);
    expect(html).toContain("weird");
    expect(html).toContain("text-muted");
  });

  it("allows an explicit tone/label override", () => {
    const html = renderToStaticMarkup(
      <StatusPill status="draft" tone="danger" label="Custom" />
    );
    expect(html).toContain("Custom");
    expect(html).toContain("text-danger");
  });
});
