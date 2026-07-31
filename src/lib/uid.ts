// Client-safe unique id. `crypto.randomUUID()` only exists in a SECURE context
// (HTTPS or localhost); this app is served over plain HTTP on the internal LAN,
// where `crypto.randomUUID` is undefined and calling it throws. Fall back to
// `crypto.getRandomValues` (available in non-secure contexts too), then to a
// timestamp+random last resort. These ids are client-only — React keys and
// field selection — and are stripped before fields are sent to the server.
export function uid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40 // version 4
    b[8] = (b[8] & 0x3f) | 0x80 // variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'))
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
