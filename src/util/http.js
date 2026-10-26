import { lookup as dnsLookup } from 'node:dns/promises';

export const USER_AGENT =
  'gev-open-sources/0.1 (+https://github.com/quanticsoul4772/gev-open-sources)';

/**
 * Entur asks every client to name itself in ET-Client-Name as
 * `<company>-<application>` and rate-limits unnamed clients strictly
 * (developer.entur.org).
 */
export const ENTUR_CLIENT_NAME = 'quanticsoul4772-gev-open-sources';

/** Headers a host asks clients to identify with. */
const clientHeaders = (url) =>
  /(^|\.)entur\.io$/.test(new URL(url).hostname) ? { 'ET-Client-Name': ENTUR_CLIENT_NAME } : {};

/**
 * Whether a response only says "not now": rate limited (429), or busy (503)
 * with a Retry-After. It says nothing about the feed.
 * @param {{status: number, headers: Headers}} res
 */
export const notNow = (res) => res.status === 429 || (res.status === 503 && res.headers.has('retry-after'));

/**
 * Per-host request pacing: one request in flight per host, and request starts
 * to one host at least `gapMs` apart. Other hosts are not held up.
 * @param {number} gapMs
 * @returns {{acquire: (url: string) => Promise<() => void>}} acquire resolves
 *   to a release function once the URL's host may be sent a request
 */
export function hostLimiter(gapMs) {
  const tails = new Map();
  const starts = new Map();
  return {
    acquire(url) {
      const host = new URL(url).hostname;
      const prev = tails.get(host) || Promise.resolve();
      let release;
      const done = new Promise((resolve) => (release = resolve));
      tails.set(host, prev.then(() => done));
      return prev.then(async () => {
        const wait = (starts.get(host) ?? -Infinity) + gapMs - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        starts.set(host, Date.now());
        return release;
      });
    },
  };
}

/**
 * GET with an identifying User-Agent, a timeout, a byte cap, and redirects
 * followed by hand: at most 3 hops, each to the URL's own origin or a host the
 * entry lists in `redirectHosts` (any host with `anyRedirect`, for one-off
 * discovery checks). The same rule as the app's transit proxy, so a feed the
 * prober verifies is one the app can fetch.
 * @param {string} url
 * @param {{headers?: Record<string,string>, redirectHosts?: string[], anyRedirect?: boolean,
 *   timeoutMs?: number, maxBytes?: number, fetchImpl?: typeof fetch,
 *   limiter?: ReturnType<typeof hostLimiter>}} [options]
 * @returns {Promise<{status: number, url: string, headers: Headers, body: Uint8Array}>}
 */
/**
 * Whether a URL's host is loopback, private, link-local or otherwise
 * internal (by name or IP literal). The harvest fetches URLs from third-party
 * catalogues and follows their redirects; it must never be steered at the CI
 * runner's own network (e.g. a cloud metadata address). Public IP literals
 * are allowed: some real feeds use them. No DNS lookup here: a public name
 * that resolves to a private address is caught by `resolvesInternal`.
 * @param {string} url
 */
export function isInternalUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;
  return isInternalAddress(host);
}

/**
 * Whether a host string is an internal IP literal (false for names).
 * @param {string} host
 */
function isInternalAddress(host) {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  if (host.includes(':')) return host === '::1' || host === '::' || /^(fc|fd|fe[89ab])/.test(host) || host.startsWith('::ffff:');
  return false;
}

/**
 * Whether a URL's host name resolves to an internal address: a public name
 * pointed at a private one must not steer the harvest into the runner's own
 * network. A name that doesn't resolve is left to the fetch, which then fails
 * with its own error. The check runs before the fetch connects, so a name that
 * changes its answer in between (DNS rebinding) is not caught.
 * @param {string} url
 * @param {(host: string, options: {all: true}) => Promise<{address: string}[]>} lookup
 */
export async function resolvesInternal(url, lookup = dnsLookup) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  // IP literals need no lookup: isInternalUrl has judged them.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false;
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return false;
  }
  return addresses.some(({ address }) => isInternalAddress(address.toLowerCase()));
}

export async function fetchCapped(
  url,
  {
    headers = {},
    redirectHosts = [],
    anyRedirect = false,
    timeoutMs = 20_000,
    maxBytes = 8 * 2 ** 20,
    fetchImpl = fetch,
    limiter = null,
    // Only the real network needs the DNS check; an injected fetch never connects.
    lookup = fetchImpl === fetch ? dnsLookup : null,
  } = {},
) {
  const origin = new URL(url).origin;
  let current = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    if (isInternalUrl(current) || (lookup && (await resolvesInternal(current, lookup))))
      throw new Error(`refusing internal address ${new URL(current).hostname}`);
    // Held until the body is read, so a host sees one request at a time.
    const release = await limiter?.acquire(current);
    try {
      const response = await fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'gzip, deflate, br',
          ...clientHeaders(current),
          ...headers,
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`redirect without location (${response.status})`);
        const next = new URL(location, current);
        const allowed =
          anyRedirect ||
          next.origin === origin ||
          redirectHosts.includes(next.hostname);
        if (!allowed) throw new Error(`redirect to unlisted host ${next.hostname}`);
        current = next.href;
        continue;
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`response over ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, url: current, headers: response.headers, body };
    } finally {
      release?.();
    }
  }
  throw new Error('too many redirects');
}
