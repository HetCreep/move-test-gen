import { readdirSync } from 'fs';
import { join } from 'path';

export function walkDir(dir, ext) {
  return walkDirInner(dir, ext, true);
}

function walkDirInner(dir, ext, isRoot) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isRoot) throw err;
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDirInner(full, ext, false));
    else if (entry.name.endsWith(ext)) results.push(full);
  }
  return results;
}
