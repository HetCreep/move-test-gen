/**
 * MOV-011: public(package) entry function is externally callable.
 *
 * The `entry` modifier makes a function callable from Programmable
 * Transaction Blocks (PTBs), regardless of other visibility modifiers.
 * A function marked `public(package) entry` looks package-scoped but
 * is actually callable by any external transaction — the `entry` keyword
 * defeats the `package` restriction for PTB calls.
 *
 * Why it matters: developers assume `public(package)` means "only
 * callable from within this package" and skip authorization checks.
 * Adding `entry` to such a function silently opens it to the world.
 * Documented in AlphaFiTech/sui-ai-commons sui-move-auditor as a
 * known Sui-native pitfall.
 *
 * Detection: any function declaration combining `public(package)` with
 * `entry`. The same applies to `public(friend) entry` in legacy editions.
 */

const RULE_ID = 'MOV-011';
const SEVERITY = 'HIGH';
const TITLE = 'public(package) entry function is externally callable via PTB';

/**
 * @param {string} source — file content
 * @param {string} filename
 * @returns {Array<{rule, severity, file, line, message}>}
 */
export function check(source, filename) {
  const findings = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('//')) continue;

    if (/^public\s*\(\s*(?:package|friend)\s*\)\s+entry\s+fun\b/.test(trimmed)) {
      const nameMatch = trimmed.match(/entry\s+fun\s+(\w+)/);
      const name = nameMatch ? nameMatch[1] : '(unknown)';
      findings.push({
        rule: RULE_ID,
        severity: SEVERITY,
        file: filename,
        line: i + 1,
        message: `${TITLE}: \`${name}\` — \`entry\` defeats the package/friend restriction for PTB callers; remove \`entry\` or add an authorization check`,
      });
    }
  }

  return findings;
}

export const meta = { id: RULE_ID, severity: SEVERITY, title: TITLE };
