/**
 * Camera lists: one JSON document listing still cameras, read through the
 * entry's `mapping` (paths relative to each listed item). A path is dot
 * segments; a number indexes an array; `[key=value]` picks the array item
 * whose `key` equals `value`. Examples:
 *   Digitraffic  items "features", lat "geometry.coordinates.1",
 *                image "properties.presets.0.id", image_template "https://weathercam.digitraffic.fi/{value}.jpg"
 *   TfL          items "" (the document is the array), image "additionalProperties[key=imageUrl].value"
 */

/** Value at `path` in `value`, or undefined. */
export function readPath(value, path) {
  if (!path) return value;
  let v = value;
  for (const segment of path.split('.')) {
    if (v === undefined || v === null) return undefined;
    const pick = segment.match(/^([^[]*)\[([^=\]]+)=([^\]]*)\]$/);
    if (pick) {
      const list = pick[1] ? v[pick[1]] : v;
      v = Array.isArray(list) ? list.find((item) => String(item?.[pick[2]]) === pick[3]) : undefined;
    } else v = v[/^\d+$/.test(segment) && Array.isArray(v) ? Number(segment) : segment];
  }
  return v;
}

const isOn = (v) => v === undefined || v === true || String(v).toLowerCase() === 'true';

/**
 * Cameras in a list document.
 * @param {any} doc
 * @param {{items: string, id: string, lat: string, lon: string, image: string,
 *   name?: string, active?: string, image_template?: string}} mapping
 * @returns {Array<{id: string, name: string|null, lat: number, lon: number, image: string}>}
 */
export function cameraRecords(doc, mapping) {
  const items = readPath(doc, mapping.items);
  if (!Array.isArray(items)) throw new Error(`no camera list at "${mapping.items}"`);
  const cameras = [];
  for (const item of items) {
    if (mapping.active && !isOn(readPath(item, mapping.active))) continue;
    const lat = Number(readPath(item, mapping.lat));
    const lon = Number(readPath(item, mapping.lon));
    const raw = readPath(item, mapping.image);
    const id = readPath(item, mapping.id);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if ((lat === 0 && lon === 0) || raw === undefined || raw === null || raw === '' || id === undefined) continue;
    const image = mapping.image_template ? mapping.image_template.replace('{value}', encodeURIComponent(String(raw))) : String(raw);
    if (!/^https:\/\//.test(image)) continue;
    const name = mapping.name ? readPath(item, mapping.name) : null;
    cameras.push({ id: String(id), name: typeof name === 'string' ? name : null, lat, lon, image });
  }
  return cameras;
}
