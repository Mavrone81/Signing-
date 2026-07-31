export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

// Clamp a normalized field rect so it stays fully inside the page ([0,1]^2)
// and keeps at least `min` width/height. Used by the editor while dragging /
// resizing field boxes so coords never leave the page. Pure geometry.
export function clampFieldRect(
  r: { x: number; y: number; w: number; h: number },
  min = 0.02,
): { x: number; y: number; w: number; h: number } {
  const w = Math.min(Math.max(r.w, min), 1)
  const h = Math.min(Math.max(r.h, min), 1)
  const x = clamp01(Math.min(Math.max(r.x, 0), 1 - w))
  const y = clamp01(Math.min(Math.max(r.y, 0), 1 - h))
  return { x, y, w, h }
}

export function normToPdfRect(
  f: { x: number; y: number; w: number; h: number },
  page: { width: number; height: number },
) {
  const x = f.x * page.width
  const width = f.w * page.width
  const height = f.h * page.height
  const y = page.height - (f.y + f.h) * page.height // flip y-axis
  return { x, y, width, height }
}
