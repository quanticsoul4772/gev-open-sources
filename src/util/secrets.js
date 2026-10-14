/**
 * Credential detection. The directory is published, so no URL in it may
 * carry a key, wherever the key sits: a query or fragment parameter, a path
 * segment after `/key/`, `user:pass@`, or a value that looks like a known
 * token format. False positives only cost a feed; a miss publishes a key.
 */

/** Parameter names that carry a credential. */
const CREDENTIAL_NAME =
  /key|token|secret|passw|pwd|signature|credential|session|jwt|bearer|^(sig|auth|code|appid|app_id|app_code|client_id|sid|pass|user|username|login|access|k|p)$/i;
/**
 * Request headers an entry may carry: ones that identify the client, never
 * ones that authenticate it (Entur requires ET-Client-Name).
 */
export const ALLOWED_HEADERS = Object.freeze(['et-client-name', 'user-agent', 'accept']);
/** Path segments whose next segment is a credential (`/api/v1/key/<key>/…`). */
const KEY_SEGMENT = /^(key|keys|token|apikey|api_key|api-key|accesskey|access_key|auth|secret)$/i;
/** Values in a known token format, anywhere in a string. */
const SECRET_VALUE =
  /eyJ[\w-]{10,}\.[\w-]{10,}|AKIA[0-9A-Z]{16}|\bsk-[\w-]{20,}|\bghp_[A-Za-z0-9]{30,}|\bxox[abposr]-[\w-]{10,}/;

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Whether a URL carries a credential. Unparsable → true.
 * @param {string} url
 */
export function hasCredential(url) {
  const raw = String(url ?? '').replace(/&amp;/gi, '&');
  if (SECRET_VALUE.test(raw)) return true;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return true;
  }
  if (u.username || u.password) return true;
  const names = [...u.searchParams.keys(), ...new URLSearchParams(u.hash.replace(/^#!?\/?/, '')).keys()];
  if (names.some((n) => CREDENTIAL_NAME.test(n))) return true;
  const segments = u.pathname.split('/').map(decode);
  return segments.some((s, i) => KEY_SEGMENT.test(s) && Boolean(segments[i + 1]));
}

/** Every URL an entry publishes: access, related, licence, catalogue licence, `via:` provenance. */
export function entryUrls(entry) {
  return [
    entry.access?.url,
    ...Object.values(entry.access?.related || {}),
    entry.licence?.url,
    entry.gbfs?.catalogue_licence,
    ...(entry.provenance || []).filter((p) => p.startsWith('via:')).map((p) => p.slice(4)),
  ].filter(Boolean);
}

/**
 * Whether an entry's request headers could carry a credential: a name not in
 * ALLOWED_HEADERS, or a value that isn't 1–100 printable ASCII characters or
 * looks like a token. The same rule as the app (gods-eye-view A0).
 */
export function headersHaveCredential(headers = {}) {
  return Object.entries(headers).some(
    ([name, value]) =>
      !ALLOWED_HEADERS.includes(name.toLowerCase()) ||
      typeof value !== 'string' ||
      !/^[ -~]{1,100}$/.test(value) ||
      SECRET_VALUE.test(value),
  );
}

export const entryHasCredential = (entry) =>
  entryUrls(entry).some(hasCredential) || headersHaveCredential(entry.access?.headers);

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/g;

/**
 * Credential findings in any JSON value: every string and object key that is
 * or contains a URL, and every string in a known token format. Findings name
 * the JSON path, never the value.
 * @returns {Array<{path: string, reason: string}>}
 */
export function scanJson(value, path = '$') {
  const findings = [];
  const check = (text, where) => {
    if (SECRET_VALUE.test(text)) findings.push({ path: where, reason: 'token-format value' });
    else if ((text.match(URL_IN_TEXT) || []).some(hasCredential)) findings.push({ path: where, reason: 'URL carries a credential' });
  };
  const walk = (v, p) => {
    if (typeof v === 'string') check(v, p);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') {
      if (typeof v.access?.url === 'string' && headersHaveCredential(v.access.headers))
        findings.push({ path: `${p}.access.headers`, reason: 'request header may carry a credential' });
      Object.entries(v).forEach(([k, x], i) => {
        // A key may itself be a URL (state files): name it by position, never by text.
        const name = /[/:?#@]/.test(k) ? `[key #${i}]` : `.${k}`;
        check(k, `${p}${name}`);
        walk(x, `${p}${name}`);
      });
    }
  };
  walk(value, path);
  return findings;
}
