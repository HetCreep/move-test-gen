/**
 * scope-filter.mjs — pure function for file scope filtering.
 * Extracted so gate-selftest can pin behavior without sui.
 */

/**
 * Filter source files to only those matching the scope list.
 * A file matches if its path ends with any entry in scopeFilter.
 *
 * @param {string[]} files - full paths of all source files
 * @param {string[]} scopeFilter - filenames to keep (e.g. ["fund.move", "oracle.move"])
 * @returns {string[]} filtered file list
 */
export function filterByScope(files, scopeFilter) {
  const norm = (p) => p.split('\\').join('/');
  const wanted = scopeFilter.map(norm);
  return files.filter(f => wanted.some(s => norm(f).endsWith(s)));
}
