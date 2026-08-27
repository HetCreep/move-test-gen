/**
 * MOV-002: Integer arithmetic without overflow protection.
 *
 * Two sub-checks:
 *   (a) Multiplication of u64 values without prior cast to u128/u256.
 *   (b) Bit-shift operations (<< >>) which silently wrap on overflow
 *       instead of aborting like + - *.
 *
 * Why it matters: The Cetus $223M exploit root cause was an incorrect
 * overflow check on a shift operation. Kriya had the identical bug.
 * Any u64 * u64 that could exceed 2^64 needs u128 promotion BEFORE
 * the multiplication, not after. Bit-shifts are worse — they don't
 * abort at all, they silently lose the high bits.
 *
 * Uses the Move parser for type tracking: if either operand is known
 * to be u128 or u256 (from let declaration, cast, or naming convention),
 * the multiplication is safe and not flagged.
 */

import { parseModule, getVarType, WIDE_TYPES } from '../scripts/move-parser.mjs';

const RULE_ID = 'MOV-002';
const SEVERITY = 'HIGH';
const TITLE = 'integer multiplication may overflow without u128 promotion';

/**
 * @param {string} source
 * @param {string} filename
 * @returns {Array<{rule, severity, file, line, message}>}
 */
export function check(source, filename) {
  const findings = [];
  const mod = parseModule(source);

  for (const fn of mod.functions) {
    // skip test functions
    if (fn.isTest || fn.isTestOnly) continue;
    if (!fn.body) continue;

    for (const mul of fn.body.multiplications) {
      const leftType = mul.leftType || getVarType(fn, mul.left);
      const rightType = mul.rightType || getVarType(fn, mul.right);

      // skip if either operand is u128/u256
      if (leftType && WIDE_TYPES.has(leftType)) continue;
      if (rightType && WIDE_TYPES.has(rightType)) continue;

      // skip if both are literals
      if (/^\d+$/.test(mul.left) && /^\d+$/.test(mul.right)) continue;

      // skip if naming convention indicates wide type
      if (/_u256$/.test(mul.left) || /_u256$/.test(mul.right)) continue;
      if (/_u128$/.test(mul.left) || /_u128$/.test(mul.right)) continue;

      // get the source line for additional context checks
      const lines = source.split('\n');
      const lineText = (lines[mul.line - 1] || '').trim();

      // skip if the line has an inline cast (as u128/u256)
      if (/as\s+u128/.test(lineText) || /as\s+u256/.test(lineText)) continue;

      // skip const declarations
      if (/const\s+\w+\s*:\s*u\d+\s*=/.test(lineText)) continue;
      if (/:\s*u128\s*=/.test(lineText) || /:\s*u256\s*=/.test(lineText)) continue;

      // skip lines that are shift operations (handled separately below)
      if (/<<|>>/.test(lineText)) continue;

      findings.push({
        rule: RULE_ID,
        severity: SEVERITY,
        file: filename,
        line: mul.line,
        message: `${TITLE}: \`${mul.left} * ${mul.right}\`${leftType ? ` (${mul.left}: ${leftType})` : ''}${rightType ? ` (${mul.right}: ${rightType})` : ''} — cast to u128 before multiplying to prevent overflow`,
      });
    }
  }

  // (b) Bit-shift detection — << and >> silently wrap on overflow
  const lines = source.split('\n');
  let inTestBlock = false;
  let inTestOnlyModule = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//')) continue;
    if (/#\[test_only\]/.test(trimmed)) { inTestOnlyModule = true; continue; }
    if (/#\[test[\],\s]/.test(trimmed)) { inTestBlock = true; continue; }
    if (/\bfun\b/.test(trimmed) && !/#\[test/.test(trimmed)) {
      inTestBlock = false;
      if (inTestOnlyModule) { inTestOnlyModule = false; continue; }
    }
    if (inTestBlock || inTestOnlyModule) continue;

    // detect << or >> on non-literal, non-const lines
    if (/(<<|>>)/.test(trimmed)) {
      // skip if line is a const declaration
      if (/const\s+\w+/.test(trimmed)) continue;
      // skip if inside a comment (already handled above)
      // skip if operand is already u128/u256
      if (/as\s+u128/.test(trimmed) || /as\s+u256/.test(trimmed)) continue;
      if (/u128\s*(<<|>>)/.test(trimmed) || /u256\s*(<<|>>)/.test(trimmed)) continue;
      // skip if this is a type annotation or generic, not arithmetic
      if (/:\s*u\d+\s*[,)]/.test(trimmed) && !/(<<|>>)/.test(trimmed.split(':')[0])) continue;

      const op = trimmed.includes('<<') ? '<<' : '>>';
      findings.push({
        rule: RULE_ID,
        severity: SEVERITY,
        file: filename,
        line: i + 1,
        message: `bit-shift \`${op}\` silently wraps on overflow — unlike +/-/*, shifts do NOT abort; validate the shift amount or cast to a wider type first`,
      });
    }
  }

  return findings;
}

export const meta = { id: RULE_ID, severity: SEVERITY, title: TITLE };
