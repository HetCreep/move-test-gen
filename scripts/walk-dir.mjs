import { readdirSync } from 'fs';
import { join } from 'path';

export function walkDir(dir, ext) {
  const results = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full, ext));
    else if (entry.name.endsWith(ext)) results.push(full);
  }
  return results;
}
