/**
 * MOV-012: Sender identity taken as an address parameter instead of ctx.
 *
 * A function that accepts a caller/sender/owner identity as a plain
 * `address` parameter trusts the caller to tell the truth about who
 * they are. Any PTB can pass any address — the parameter is spoofable.
 * The safe alternative is `tx_context::sender(ctx)` inside the function.
 *
 * Why it matters: if `public fun withdraw(sender: address, ...)` checks
 * `assert!(sender == vault.owner)`, an attacker simply passes the real
 * owner's address and bypasses the check entirely. Documented in
 * AlphaFiTech/sui-ai-commons sui-move-auditor as a Sui-native pitfall.
 *
 * Detection: any public/entry function with a parameter whose name
 * suggests caller identity (sender, caller, user, owner, admin, signer,
 * authority, operator) AND whose type is bare `address`.
 */

const RULE_ID = 'MOV-012';
const SEVERITY = 'HIGH';
const TITLE = 'sender identity taken as spoofable address parameter';

const IDENTITY_NAMES = /^(?:sender|caller|user|owner|admin|signer|authority|operator|from|recipient)$/i;

/**
 * @param {string} source — file content
 * @param {string} filename
 * @returns {Array<{rule, severity, file, line, message}>}
 */
export function check(source, filename) {
  const findings = [];
  const lines = source.split('\n');

  let testOnlyNext = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('//')) continue;

    if (/#\[test_only\]/.test(trimmed)) {
      testOnlyNext = true;
      const afterAttr = trimmed.replace(/^#\[test_only\]\s*/, '');
      if (/\b(fun|use|struct|const|entry)\b/.test(afterAttr)) testOnlyNext = false;
      continue;
    }

    const isTestOnly = testOnlyNext;
    if (testOnlyNext && /\b(fun|use|struct|const|entry)\b/.test(trimmed)) testOnlyNext = false;

    // match public/entry function declarations
    const fnMatch = trimmed.match(/^public(?:\s*\((?:package|friend)\))?\s+(?:entry\s+)?fun\s+(\w+)/);
    const entryMatch = !fnMatch && trimmed.match(/^entry\s+fun\s+(\w+)/);
    const match = fnMatch || entryMatch;
    if (!match) continue;
    if (isTestOnly) continue;

    const name = match[1];
    if (name === 'init' || name.includes('testing') || name.includes('destroy')) continue;
    if (name.startsWith('test_') || name.endsWith('_test')) continue;

    // collect full parameter string (may span multiple lines)
    let paramStr = '';
    let depth = 0;
    let started = false;
    for (let j = i; j < Math.min(i + 10, lines.length); j++) {
      for (const ch of lines[j]) {
        if (ch === '(') { depth++; started = true; }
        if (started && depth > 0) paramStr += ch;
        if (ch === ')') { depth--; if (started && depth === 0) break; }
      }
      if (started && depth === 0) break;
    }
    paramStr = paramStr.slice(1); // remove leading (

    // parse each parameter
    const params = paramStr.split(',').map(p => p.trim()).filter(Boolean);
    for (const param of params) {
      const m = param.match(/(\w+)\s*:\s*(&mut\s+|&)?\s*(\w+)/);
      if (!m) continue;
      const paramName = m[1];
      const paramType = m[3];
      if (IDENTITY_NAMES.test(paramName) && paramType === 'address') {
        findings.push({
          rule: RULE_ID,
          severity: SEVERITY,
          file: filename,
          line: i + 1,
          message: `${TITLE}: \`${name}\` takes \`${paramName}: address\` — use \`tx_context::sender(ctx)\` instead; a PTB caller can pass any address`,
        });
      }
    }
  }

  return findings;
}

export const meta = { id: RULE_ID, severity: SEVERITY, title: TITLE };
