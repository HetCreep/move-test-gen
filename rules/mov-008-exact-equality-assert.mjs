/**
 * MOV-008: Exact-equality assert on caller-supplied payment amounts.
 *
 * `assert!(payment == required)` on a value the caller controls is a
 * denial-of-service vector: dust, rounding, or fee-on-transfer tokens
 * make exact equality impossible to hit, so every transaction aborts.
 * The safe alternative is `assert!(payment >= required)`.
 *
 * Why it matters: documented in AlphaFiTech/sui-ai-commons
 * sui-move-auditor as a known DeFi pitfall. Protocols that enforce
 * exact payment matching brick their own users the moment any amount
 * drifts by a single unit.
 *
 * Detection: assert! containing `==` where at least one operand name
 * suggests a caller-controlled payment value (amount, payment, price,
 * deposit, fee, cost, value, balance, collateral).
 */

const RULE_ID = 'MOV-008';
const SEVERITY = 'MEDIUM';
const TITLE = 'exact-equality assert on payment amount — use >= instead';

const PAYMENT_NAMES = /\b(?:amount|payment|price|deposit|fee|cost|collateral|paid|received)\b/i;

/**
 * @param {string} source
 * @param {string} filename
 * @returns {Array<{rule, severity, file, line, message}>}
 */
export function check(source, filename) {
  const findings = [];
  const lines = source.split('\n');

  let inTest = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('//')) continue;
    if (/#\[test_only\]/.test(trimmed) || /#\[test[\],\s]/.test(trimmed)) {
      inTest = true;
      continue;
    }
    if (inTest && /\bfun\b/.test(trimmed)) {
      if (/#\[test/.test(trimmed)) { inTest = true; }
      else { inTest = false; }
    }
    if (inTest) continue;

    // match assert! with == inside
    const assertMatch = trimmed.match(/assert!\s*\((.+)/);
    if (!assertMatch) continue;

    // get the full assert expression (may span this line)
    let expr = assertMatch[1];

    // check for == (not !=)
    if (!expr.includes('==') || expr.includes('!=')) continue;

    // split on == and check if either side has a payment-related name
    const parts = expr.split('==');
    if (parts.length < 2) continue;

    const left = parts[0].trim();
    const right = parts[1].trim();

    if (PAYMENT_NAMES.test(left) || PAYMENT_NAMES.test(right)) {
      // exclude version/type checks like assert!(version == CURRENT_VERSION)
      if (/version|type|kind|status|state|flag|mode|role/i.test(left + right)) continue;
      // exclude zero checks like assert!(amount == 0)
      if (/^0\b/.test(right.trim()) || /^0\b/.test(left.trim())) continue;

      const fnName = findEnclosingFunction(lines, i);
      findings.push({
        rule: RULE_ID,
        severity: SEVERITY,
        file: filename,
        line: i + 1,
        message: `${TITLE}: \`${fnName || '(unknown)'}\` asserts exact equality on a payment value — an off-by-one dust amount aborts the entire transaction`,
      });
    }
  }

  return findings;
}

function findEnclosingFunction(lines, lineIdx) {
  for (let j = lineIdx; j >= Math.max(0, lineIdx - 30); j--) {
    const m = lines[j].match(/fun\s+(\w+)/);
    if (m) return m[1];
  }
  return null;
}

export const meta = { id: RULE_ID, severity: SEVERITY, title: TITLE };
