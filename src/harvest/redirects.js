import { USER_AGENT, registrableDomain } from '../util/http.js';
import { hostOfUrl, runPooled } from '../util/pool.js';

/**
 * Follow redirects hop by hop (≤ 3) without downloading bodies, and return the
 * final URL when it lands on another registrable domain — e.g. data.gouv.fr
 * dataset permalinks that 302 to the operator's own feed host. Same-domain
 * redirects are left alone (the prober follows those itself).
 * @returns {Promise<string|null>}
 */
export async function crossDomainTarget(url, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop < 3; hop += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return null;
    }
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    current = new URL(location, current).href;
  }
  if (current === url) return null;
  return registrableDomain(new URL(current).hostname) ===
    registrableDomain(new URL(url).hostname)
    ? null
    : current;
}

/**
 * Point entries that redirect to another domain at their final URL; the
 * original stays in provenance.
 * @param {object[]} entries entries to check (new ones, and ones whose last probe failed)
 * @returns {Promise<object[]>} the entries that changed
 */
export async function resolveRedirects(entries, fetchImpl = fetch) {
  const targets = await runPooled(
    entries,
    (e) => hostOfUrl(e.access.url),
    (e) => crossDomainTarget(e.access.url, fetchImpl),
    { global: 16, perHost: 3 },
  );
  const changed = [];
  entries.forEach((entry, i) => {
    const target = typeof targets[i] === 'string' ? targets[i] : null;
    if (!target) return;
    changed.push({
      ...entry,
      access: { ...entry.access, url: target },
      provenance: [...entry.provenance.filter((p) => !p.startsWith('via:')), `via:${entry.access.url}`],
    });
  });
  return changed;
}
