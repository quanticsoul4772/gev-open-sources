export const USER_AGENT =
  'gev-open-sources/0.1 (+https://github.com/quanticsoul4772/gev-open-sources)';

/** Query parameters that carry a credential: a URL with one is not keyless. */
const CREDENTIAL_PARAM =
  /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|auth[_-]?token|secret|client[_-]?secret|subscription[_-]?key|password|pwd|sig|signature)$/i;

/** @param {string} url @returns {boolean} */
export function hasCredentialParam(url) {
  try {
    for (const key of new URL(url).searchParams.keys())
      if (CREDENTIAL_PARAM.test(key)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * GET with an identifying User-Agent, a timeout, a byte cap, and redirects
 * followed by hand: at most 3 hops, each to the URL's own origin or a host the
 * entry lists in `redirectHosts` (any host with `anyRedirect`, for one-off
 * discovery checks). The same rule as the app's transit proxy, so a feed the
 * prober verifies is one the app can fetch.
 * @param {string} url
 * @param {{headers?: Record<string,string>, redirectHosts?: string[], anyRedirect?: boolean,
 *   timeoutMs?: number, maxBytes?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{status: number, url: string, headers: Headers, body: Uint8Array}>}
 */
export async function fetchCapped(
  url,
  {
    headers = {},
    redirectHosts = [],
    anyRedirect = false,
    timeoutMs = 20_000,
    maxBytes = 8 * 2 ** 20,
    fetchImpl = fetch,
  } = {},
) {
  const origin = new URL(url).origin;
  let current = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'gzip, deflate, br',
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
  }
  throw new Error('too many redirects');
}
