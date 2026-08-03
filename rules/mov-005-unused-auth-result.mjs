/**
 * MOV-005: Authorization check result discarded (Typus pattern).
 *
 * Flags calls to bool-returning authorization functions where the
 * result is not bound to a variable, not passed to assert!, and
 * not used in an if/while condition. The call runs but the answer
 * is thrown away — the authorization is theater.
 *
 * Why it matters: Typus Finance lost $3.44M because update_v2 called
 * vector::contains() on an authority whitelist and discarded the bool.
 * The check looked correct to every reviewer — the function name,
 * the arguments, even the comment ("check authority") all matched.
 * Only the assert! was missing. Move has no #[must_use] to catch this.
 *
 * Detection: standalone expression statements matching known auth
 * patterns without let binding, assert!, or if/while context.
 */

const RULE_ID = 'MOV-005';
const SEVERITY = 'HIGH';
const TITLE = 'authorization check result discarded';

const AUTH_PATTERNS = [
  /vector::contains\s*\(/,
  /\w+::contains\s*\(/,
  /\bcontains\s*\(/,
  /\w+::has\s*\(/,
  /\bhas\s*\(/,
  /\bis_authorized\s*\(/,
  /\bis_admin\s*\(/,
  /\bis_owner\s*\(/,
  /\bis_valid\s*\(/,
  /\bcheck_auth\w*\s*\(/,
  /\bverify\s*\(/,
  /\bhas_role\s*\(/,
  /\bhas_permission\s*\(/,
];

const SAFE_CONTEXTS = [
  /assert!\s*\(/,
  /\blet\s+/,
  /\bif\s*[\s(]/,
  /\bwhile\s*\(/,
  /\breturn\b/,
  /&&/,
  /\|\|/,
  /^!/,
  /=\s*$/,
];

/**
 * @param {string} source
 * @param {string} filename
 * @returns {Array<{rule, severity, file, line, message}>}
 */
export function check(source, filename) {
  const findings = [];
  const lines = source.split('\n');

  let skipNextItem = false;
  let inTestModule = false;
  let inTestFun = false;
  let testBraceDepth = 0;
  let moduleBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '' || /^\/\//.test(trimmed)) continue;

    if (/^#\[test_only\]/.test(trimmed)) { skipNextItem = true; continue; }
    if (/^#\[test\b/.test(trimmed)) { skipNextItem = true; continue; }

    // track test_only modules
    if (skipNextItem && /\bmodule\b/.test(trimmed)) {
      inTestModule = true;
      skipNextItem = false;
      continue;
    }

    // track test/test_only functions
    if (skipNextItem && /\bfun\b/.test(trimmed)) {
      inTestFun = true;
      testBraceDepth = 0;
      skipNextItem = false;
    }

    if (skipNextItem && !(/\bfun\b/.test(trimmed)) && !(/\bmodule\b/.test(trimmed))) {
      skipNextItem = false;
    }

    // brace tracking for test functions
    if (inTestFun) {
      for (const ch of trimmed) {
        if (ch === '{') testBraceDepth++;
        if (ch === '}') testBraceDepth--;
      }
      if (testBraceDepth <= 0 && trimmed.includes('}')) {
        inTestFun = false;
      }
      continue;
    }

    if (inTestModule) continue;

    // skip _test suffix functions
    if (/\bfun\s+\w+_test\b/.test(trimmed)) {
      inTestFun = true;
      testBraceDepth = 0;
      for (const ch of trimmed) {
        if (ch === '{') testBraceDepth++;
        if (ch === '}') testBraceDepth--;
      }
      continue;
    }

    // check for standalone auth calls
    const isAuthCall = AUTH_PATTERNS.some(p => p.test(trimmed));
    if (!isAuthCall) continue;

    const isSafe = SAFE_CONTEXTS.some(p => p.test(trimmed));
    if (isSafe) continue;

    // check previous line for multi-line assert!/if
    const prevLine = (i > 0 ? lines[i - 1].trim() : '');
    if (/assert!\s*\(\s*$/.test(prevLine)) continue;
    if (/if\s*\(\s*$/.test(prevLine)) continue;

    if (trimmed.endsWith(';') || trimmed.endsWith(');')) {
      const callMatch = trimmed.match(/(\w+(?:::\w+)?)\s*\(/);
      const fnName = callMatch ? callMatch[1] : 'call';

      findings.push({
        rule: RULE_ID,
        severity: SEVERITY,
        file: filename,
        line: i + 1,
        message: `${TITLE}: \`${fnName}()\` returns bool but result is discarded — wrap in assert!() or bind to a variable`,
      });
    }
  }

  return findings;
}

export const meta = { id: RULE_ID, severity: SEVERITY, title: TITLE };
