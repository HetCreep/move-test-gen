/**
 * MOV-006: Shared abort code across multiple functions.
 *
 * Flags abort codes (numeric or named constants) used in assert! across
 * two or more public functions. When the same code fires from different
 * call sites, the caller cannot tell which function aborted or why.
 *
 * Why it matters: Bucket Protocol uses 404 for every assert in its test
 * suite. In eval lab scenario 01, ENotPositive was used by add(), scale(),
 * and reserve() — a test observing abort code 1 cannot distinguish which
 * function failed. Debugging requires reading the call stack, not the code.
 *
 * Detection: collect all abort codes per public function (from assert!
 * statements), flag any code used in 2+ different public functions.
 * One finding per shared code, listing all functions that use it.
 */

const RULE_ID = 'MOV-006';
const SEVERITY = 'LOW';
const TITLE = 'abort code shared across multiple public functions';

// [^,]+ for the condition stops at the FIRST comma -- wrong whenever the
// condition itself contains one, which a nested multi-arg call does all the
// time (`assert!(table::contains(t, k), E_CODE)`): it captured `k`, the
// call's own second argument, as if it were the abort code. check-coverage.mjs
// already solved this the same way real Move parses it -- greedy across the
// whole condition, so backtracking lands on the LAST comma, the assert's own
// -- and additionally tolerates a parenthesised code and a trailing comma
// (both valid Move, both introduced by the GHSA-w7pc fix). Matched here too.
const ASSERT_RE = /assert!\s*\(.*,\s*\(?\s*(\w+)\s*\)?\s*,?\s*\)/g;
const FUN_RE = /^\s*(public\s+(?:entry\s+)?fun|entry\s+fun|public\s*\(friend\)\s+fun|public\s*\(package\)\s+fun)\s+(\w+)/;
const TEST_ATTR_RE = /^\s*#\[test/;
const TEST_ONLY_ATTR_RE = /^\s*#\[test_only\]/;

/**
 * @param {string} source
 * @param {string} filename
 * @returns {Array<{rule, severity, file, line, message}>}
 */
function collectAsserts(trimmed, fn, lineNo, codeUsage) {
  ASSERT_RE.lastIndex = 0;
  let m;
  while ((m = ASSERT_RE.exec(trimmed)) !== null) {
    const code = m[1].trim();
    // skip pure numeric 0 (common placeholder)
    if (code === '0') continue;
    // skip lowercase single words that look like variables, not error constants
    // abort codes are typically UPPER_CASE, EErrorName, or numeric
    if (/^[a-z][a-z_]*$/.test(code) && !code.startsWith('e_')) continue;
    if (!codeUsage.has(code)) codeUsage.set(code, []);
    codeUsage.get(code).push({ fn, line: lineNo });
  }
}

export function check(source, filename) {
  const findings = [];
  const lines = source.split('\n');

  // collect: { abortCode -> [{ fn, line }] }
  const codeUsage = new Map();

  let currentFn = null;
  let skipNextItem = false;
  let inTestFn = false;
  let testFnDepth = 0;
  let braceDepth = 0;
  let fnBraceStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '' || /^\/\//.test(trimmed)) continue;

    if (TEST_ONLY_ATTR_RE.test(trimmed) || TEST_ATTR_RE.test(trimmed)) {
      skipNextItem = true;
      continue;
    }

    // track braces -- remember the depth BEFORE this line's own braces so a
    // single-line function body ("public fun f() { assert!(...); }") can be
    // told apart from a signature line that only OPENS the body. A netted
    // per-line delta alone can't tell them apart: both end the line at the
    // same depth they started, once open+close on one line cancel out.
    const braceDepthBeforeLine = braceDepth;
    for (const ch of trimmed) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    // skip test_only modules entirely
    if (skipNextItem && /\bmodule\b/.test(trimmed)) {
      // entire module is test_only — skip rest of file
      return findings;
    }

    // skip test/test_only functions by tracking their braces
    if (inTestFn) {
      if (braceDepth <= testFnDepth && trimmed.includes('}')) {
        inTestFn = false;
      }
      continue;
    }

    // detect function start
    const fnMatch = FUN_RE.exec(trimmed);
    if (fnMatch) {
      if (skipNextItem || fnMatch[2].endsWith('_test')) {
        skipNextItem = false;
        inTestFn = true;
        testFnDepth = braceDepth - 1;
        currentFn = null;
        continue;
      }
      skipNextItem = false;
      currentFn = fnMatch[2];
      fnBraceStart = braceDepth;
      // Single-line body: this line's own brace delta closed back to (or
      // below) where it started, so braceDepth never reflects "inside the
      // function" and no later line will ever trip the function-end check
      // below. Collect this line's asserts right now, under this function,
      // then close it immediately.
      //
      // A net delta of 0 is ALSO what a wrapped signature line looks like
      // ("public fun foo(" with the params and opening `{` still to come
      // on later lines) -- it contains no braces at all, so the delta is
      // trivially 0 <= 0 with nothing having opened OR closed. Require
      // this line to have actually opened a brace before treating it as a
      // complete single-line body, or a wrapped signature gets misread as
      // "already closed" and currentFn is cleared before its real body is
      // ever scanned -- ten real findings on the maintainer's own oracle/
      // farm fixtures went silent this way (12 -> 7 MOV-006 findings).
      if (trimmed.includes('{') && braceDepth <= braceDepthBeforeLine) {
        collectAsserts(trimmed, currentFn, i + 1, codeUsage);
        currentFn = null;
      }
      continue;
    }

    skipNextItem = false;

    // detect function end
    if (currentFn && braceDepth < fnBraceStart) {
      currentFn = null;
    }

    if (!currentFn) continue;

    // collect abort codes from assert! statements
    collectAsserts(trimmed, currentFn, i + 1, codeUsage);
  }

  // find codes used in 2+ different functions
  for (const [code, usages] of codeUsage) {
    const uniqueFns = [...new Set(usages.map(u => u.fn))];
    if (uniqueFns.length < 2) continue;

    const firstUsage = usages[0];
    findings.push({
      rule: RULE_ID,
      severity: SEVERITY,
      file: filename,
      line: firstUsage.line,
      message: `${TITLE}: \`${code}\` used in ${uniqueFns.length} functions (${uniqueFns.join(', ')}) — callers cannot distinguish which function aborted`,
    });
  }

  return findings;
}

export const meta = { id: RULE_ID, severity: SEVERITY, title: TITLE };
