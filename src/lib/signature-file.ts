// Pure predicate for the Upload tab of SignatureModal: only PNG/JPEG source
// images are accepted (they get redrawn onto a canvas and re-exported as
// PNG). Kept in its own module — separate from the canvas drawing/export
// code — so it's unit-testable: jsdom (this repo's vitest environment) has
// no real <canvas> backend, so anything touching getContext()/toDataURL
// can't be meaningfully asserted here and is left to the Task 13 e2e suite.
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);

export function isSupportedSignatureImage(file: { type: string }): boolean {
  return SUPPORTED_IMAGE_TYPES.has(file.type);
}
