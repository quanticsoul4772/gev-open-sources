import fs from 'node:fs';

const KNOWN = JSON.parse(
  fs.readFileSync(new URL('./known-licences.json', import.meta.url), 'utf8'),
);

/**
 * Lookup key for a licence URL or SPDX id: no scheme, no `www.`, no query or
 * fragment, no `/deed.xx` or `/legalcode`, no trailing slash, lowercase;
 * `spdx.org/licenses/X(.html)` and bare SPDX ids → `spdx:x`.
 * @param {string|null|undefined} value
 */
export function licenceKey(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw.includes('/')) return `spdx:${raw.toLowerCase()}`;
  let key = raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/(deed\.[a-z-]+|legalcode(\.[a-z-]+)?)\/?$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  const spdx = key.match(/^spdx\.org\/licenses\/([^/]+?)(\.html)?$/);
  if (spdx) key = `spdx:${spdx[1]}`;
  return key;
}

/** Known licence for a URL or SPDX id, or null. */
export function knownLicence(value) {
  const key = licenceKey(value);
  return key && Object.hasOwn(KNOWN, key) ? { key, ...KNOWN[key] } : null;
}
