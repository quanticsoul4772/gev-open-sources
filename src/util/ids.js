import { createHash } from 'node:crypto';

/** A schema-valid id from any string: lowercase, [a-z0-9-], ≤ 64 chars. */
export function slugId(prefix, raw) {
  const base = String(raw).toLowerCase().startsWith(`${prefix}-`)
    ? String(raw)
    : `${prefix}-${String(raw)}`;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= 64) return slug;
  const hash = createHash('sha256').update(String(raw)).digest('hex').slice(0, 8);
  return `${slug.slice(0, 55).replace(/-+$/, '')}-${hash}`;
}

/** URL identity for dedupe: lowercase scheme/host, query string kept. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return String(url);
  }
}
