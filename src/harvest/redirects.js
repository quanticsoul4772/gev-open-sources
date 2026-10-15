import { USER_AGENT, isInternalUrl } from '../util/http.js';
import { hasCredential } from '../util/secrets.js';
import { hostOfUrl, runPooled } from '../util/pool.js';

/**
 * Follow redirects hop by hop (≤ 3) without downloading bodies, and return the
 * final URL when it lands on another origin — e.g. data.gouv.fr dataset
 * permalinks that 302 to the operator's own feed host, or http → https.
 * Same-origin redirects are left alone (the prober and the app follow those).
 * @returns {Promise<string|null>}
 */
export async function crossOriginTarget(url, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop < 3; hop += 1) {
    // Never follow (or publish) a redirect into the runner's own network.
    if (isInternalUrl(current)) return null;
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
  if (current === url || isInternalUrl(current)) return null;
  return new URL(current).origin === new URL(url).origin ? null : current;
}

/**
 * Point entries that redirect to another origin at their final URL; the
 * original stays in provenance. A final URL that carries a credential (an
 * operator key the permalink hands out) is never stored: the entry keeps the
 * permalink and lists the target host in `redirectHosts`, so the prober
 * follows the redirect instead.
 * @param {object[]} entries entries to check (new ones, and ones whose last probe failed)
 * @returns {Promise<object[]>} the entries that changed
 */
export async function resolveRedirects(entries, fetchImpl = fetch) {
  const targets = await runPooled(
    entries,
    (e) => hostOfUrl(e.access.url),
    (e) => crossOriginTarget(e.access.url, fetchImpl),
    { global: 16, perHost: 3 },
  );
  const changed = [];
  entries.forEach((entry, i) => {
    const target = typeof targets[i] === 'string' ? targets[i] : null;
    if (!target) return;
    if (hasCredential(target)) {
      const host = new URL(target).hostname;
      if (!entry.access.redirectHosts.includes(host))
        changed.push({ ...entry, access: { ...entry.access, redirectHosts: [...entry.access.redirectHosts, host] } });
      return;
    }
    changed.push({
      ...entry,
      access: { ...entry.access, url: target },
      // Earlier permalinks stay: catalogues may still list them.
      provenance: [...new Set([...entry.provenance, `via:${entry.access.url}`])],
    });
  });
  return changed;
}
