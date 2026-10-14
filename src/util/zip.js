import { inflateRawSync } from 'node:zlib';

/**
 * Read one named entry from a zip archive (stored or deflated), using the
 * central directory so sizes are known even when local headers defer them.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {number} [maxBytes] cap on the inflated size
 * @returns {Uint8Array}
 */
export function readZipEntry(bytes, name, maxBytes = 32 * 2 ** 20) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const entryName = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (size > maxBytes) throw new Error(`zip entry over ${maxBytes} bytes`);
    const start =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8)
      return new Uint8Array(inflateRawSync(data, { maxOutputLength: maxBytes }));
    throw new Error(`unsupported zip method ${method}`);
  }
  throw new Error(`zip entry ${name} not found`);
}
