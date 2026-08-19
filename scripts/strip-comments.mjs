/**
 * Strip block comments from Move source text.
 * String- and line-comment-aware: ignores comment markers inside quoted
 * strings, and inside `//` line comments (so an apostrophe in ordinary
 * prose like "don't" cannot flip the scanner into string mode and swallow
 * every `/* *\/` block for the rest of the file).
 * Preserves line count (replaces comment content with spaces) so that
 * line numbers in findings remain correct.
 */
export function stripBlockComments(text) {
  let result = '';
  let inBlock = false;
  let inString = false;
  let inLineComment = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      result += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; result += '  '; }
      else result += (ch === '\n' ? '\n' : ' ');
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === '\\') { result += (next || ''); i++; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; result += ch; continue; }
    if (ch === '"' || ch === '\'') { inString = true; quote = ch; result += ch; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; result += '  '; continue; }
    result += ch;
  }
  return result;
}
