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
 * Uses the Move parser (scripts/move-parser.mjs) for signature
 * reassembly, so a same-line attribute (`#[allow(...)] public(package)
 * entry fun f(...)`) or a declaration wrapped across lines
 * (`public(package)\nentry fun f(...)`) is still recognised, not just
 * the single anchored-line shape. A #[test_only]/#[test] function is
 * exempt -- it is never deployed, so flagging it is a false positive.
 */

import { parseModule } from '../scripts/move-parser.mjs';

const RULE_ID = 'MOV-011';
const SEVERITY = 'HIGH';
const TITLE = 'public(package) entry function is externally callable via PTB';

const FLAGGED_VISIBILITIES = new Set(['public(package) entry', 'public(friend) entry']);

/**
 * @param {string} source — file content
 * @param {string} filename
 * @returns {Array<{rule, severity, file, line, message}>}
 */
export function check(source, filename) {
  const findings = [];
  const mod = parseModule(source);

  for (const fn of mod.functions) {
    // A #[test_only]/#[test] helper is never deployed -- the same
    // exemption MOV-002/MOV-004 already apply via the parser's own flags.
    if (fn.isTest || fn.isTestOnly) continue;
    if (!FLAGGED_VISIBILITIES.has(fn.visibility)) continue;

    findings.push({
      rule: RULE_ID,
      severity: SEVERITY,
      file: filename,
      line: fn.startLine,
      message: `${TITLE}: \`${fn.name}\` — \`entry\` defeats the package/friend restriction for PTB callers; remove \`entry\` or add an authorization check`,
    });
  }

  return findings;
}

export const meta = { id: RULE_ID, severity: SEVERITY, title: TITLE };
