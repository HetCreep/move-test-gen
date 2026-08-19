/**
 * MOV-003: Division without zero-denominator check.
 *
 * Flags division operations (/) where the denominator is a variable
 * and no assert!(denom != 0) or assert!(denom > 0) appears in the
 * preceding lines of the same function.
 *
 * Why it matters: Move VM aborts on division by zero, but the abort
 * gives no context — just a raw arithmetic error. An explicit assert
 * with a named error code makes the failure diagnosable and testable.
 * Every production-grade DeFi contract (fee calculations, share math,
 * oracle scaling) should check before dividing.
 *
 * What this catches:
 *   let result = amount / total_supply;  — no prior check on total_supply
 *
 * What this skips:
 *   let result = amount / 10000;  — literal denominator, always nonzero
 */

const RULE_ID = 'MOV-003';
const SEVERITY = 'MEDIUM';
const TITLE = 'division by variable without zero-check';

/**
 * @param {string} source
 * @param {string} filename
 * @returns {Array<{rule, severity, file, line, message}>}
 */
export function check(source, filename) {
  const findings = [];
  const lines = source.split('\n');

  // track function boundaries for scope
  let inFunction = false;
  let fnStartLine = 0;
  let braceDepth = 0;
  let fnLines = [];
  let isTestFn = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('//')) continue;

    if (/^#\[test[\],\s]/.test(trimmed) || /^#\[test_only\]/.test(trimmed)) {
      isTestFn = true;
    }

    // clear test flag on any item keyword, not just fun (GHSA-5499)
    if (isTestFn && /\b(fun|use|struct|const|entry)\b/.test(trimmed)) {
      if (!/\bfun\s+\w+/.test(trimmed)) { isTestFn = false; }
    }

    // detect function start
    if (/\bfun\s+\w+/.test(trimmed)) {
      inFunction = true;
      if (isTestFn) { inFunction = false; isTestFn = false; continue; }
      isTestFn = false;
      fnStartLine = i;
      fnLines = [];
      braceDepth = 0;
    }

    if (inFunction) {
      fnLines.push({ text: trimmed, lineNo: i + 1 });
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;

      if (braceDepth <= 0 && fnLines.length > 1) {
        // function ended — analyze it
        analyzeFn(fnLines, filename, findings);
        inFunction = false;
        fnLines = [];
      }
    }
  }

  return findings;
}

function analyzeFn(fnLines, filename, findings) {
  // Zero-checked variables, built up as we walk the function top to bottom --
  // Move executes in source order, so a check below a division never ran
  // before it. Single forward pass: evaluate this line's divisions against
  // whatever was checked on EARLIER lines, then add this line's own checks.
  const checkedVars = new Set();

  for (const { text, lineNo } of fnLines) {
    if (!text.startsWith('//')) {
      // match: expr / variable (not literal)
      const divMatches = [...text.matchAll(/(\w+)\s*\/\s*(\w+)/g)];
      for (const m of divMatches) {
        const denom = m[2];

        // skip literal denominators (numbers)
        if (/^\d+$/.test(denom)) continue;

        // skip if denominator was checked on an earlier line
        if (checkedVars.has(denom)) continue;

        // skip if denom is a field access result (likely checked elsewhere)
        // but still flag — better to warn than miss

        // skip comment-like patterns
        if (text.includes('//')) {
          const commentStart = text.indexOf('//');
          if (m.index > commentStart) continue;
        }

        findings.push({
          rule: RULE_ID,
          severity: SEVERITY,
          file: filename,
          line: lineNo,
          message: `${TITLE}: \`/ ${denom}\` — add \`assert!(${denom} != 0, E...)\` before dividing`,
        });
      }

      // Checks on THIS line protect divisions on LATER lines only (added
      // after the division scan above, not before). Guarded by the same
      // "not a comment line" check as the division scan -- a commented-out
      // `assert!` must not register as a real check either.

      // assert!(x != 0, ...) or assert!(x > 0, ...)
      const checkMatch = text.match(/assert!\s*\(\s*(\w+)\s*(!= 0|> 0)/);
      if (checkMatch) checkedVars.add(checkMatch[1]);

      // x != 0 / x > 0 in an if condition
      const ifCheck = text.match(/if\s*\(\s*(\w+)\s*(!= 0|> 0)/);
      if (ifCheck) checkedVars.add(ifCheck[1]);

      // x == 0 only counts as a guard if this same line also aborts --
      // `if (x == 0) {}` (or any non-aborting body) checks nothing and must
      // not silence a real division below it.
      const zeroGuard = text.match(/if\s*\(\s*(\w+)\s*== 0\s*\).*\b(abort|assert!\s*\(\s*false)\b/);
      if (zeroGuard) checkedVars.add(zeroGuard[1]);
    }
  }
}

export const meta = { id: RULE_ID, severity: SEVERITY, title: TITLE };
