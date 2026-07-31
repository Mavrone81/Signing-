// Turn an arbitrary organization name into a URL-safe slug base:
// lowercase, non-alphanumerics collapsed to single hyphens, trimmed. Falls
// back to 'org' when the name has no usable characters (e.g. all symbols).
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'org'
}
