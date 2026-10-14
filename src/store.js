import fs from 'node:fs';
import path from 'node:path';
import { validateEntry } from './schema.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const ENTRIES_DIR = path.join(ROOT, 'entries');
export const STATE_DIR = path.join(ROOT, 'state');
export const DIST_DIR = path.join(ROOT, 'dist');

/** @returns {Map<string, object>} id → entry */
export function readEntries(dir = ENTRIES_DIR) {
  const entries = new Map();
  if (!fs.existsSync(dir)) return entries;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const errors = validateEntry(entry);
    if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
    entries.set(entry.id, entry);
  }
  return entries;
}

/** Write an entry; unchanged content leaves the file untouched (no git churn). */
export function writeEntry(entry, dir = ENTRIES_DIR) {
  const errors = validateEntry(entry);
  if (errors.length) throw new Error(`${entry.id}: ${errors.join('; ')}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.id}.json`);
  const text = `${JSON.stringify(entry, null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

export function removeEntry(id, dir = ENTRIES_DIR) {
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) fs.rmSync(file);
}

/** JSON state file (health, licence cache); missing → fallback. */
export function readState(name, fallback, dir = STATE_DIR) {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

export function writeState(name, value, dir = STATE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value)}\n`);
}
