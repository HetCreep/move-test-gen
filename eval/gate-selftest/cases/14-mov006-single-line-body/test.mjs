#!/usr/bin/env node
/**
 * MOV-006 tracks a function's body boundaries by netting brace counts per
 * line: `{` increments, `}` decrements, and the function is considered
 * closed once depth drops back below where it opened. For a single-line
 * body ("public fun f() { assert!(...); }") the open and close land on the
 * SAME line and net to zero -- braceDepth never reflects "inside the
 * function", so the code that sets `currentFn` immediately `continue`s
 * before ever scanning that line for asserts. Two public functions sharing
 * an abort code produced 0 findings when written single-line, and 1 when
 * the identical code was written multi-line -- fail-open, and it is the
 * very thing this rule exists to catch (flagged during PR #66, not
 * previously fixed or pinned).
 *
 * Fixed by remembering the brace depth BEFORE each line's own braces are
 * applied, so a signature line whose net delta is <= 0 (opens and closes
 * within itself) is recognised as a complete single-line body: its asserts
 * are collected immediately, under the function that was just matched.
 */
import { check } from '../../../../rules/mov-006-shared-abort-code.mjs';

const errs = [];
function assert(label, cond) {
  if (!cond) errs.push(label);
}

const singleLine = `module s::s {
    const EDup: u64 = 1;
    public fun a(x: u64) { assert!(x > 0, EDup); }
    public fun b(y: u64) { assert!(y > 1, EDup); }
}`;

const multiLine = `module s::s {
    const EDup: u64 = 1;
    public fun a(x: u64) {
        assert!(x > 0, EDup);
    }
    public fun b(y: u64) {
        assert!(y > 1, EDup);
    }
}`;

const singleLineUnique = `module s::s {
    const E1: u64 = 1;
    const E2: u64 = 2;
    public fun a(x: u64) { assert!(x > 0, E1); }
    public fun b(y: u64) { assert!(y > 1, E2); }
}`;

const singleFindings = check(singleLine, 's.move');
assert(
  'single-line functions sharing an abort code must be flagged (was: 0 findings)',
  singleFindings.length === 1 && singleFindings[0].message.includes('EDup')
);

const multiFindings = check(multiLine, 's.move');
assert(
  'multi-line functions sharing an abort code must still be flagged (control)',
  multiFindings.length === 1 && multiFindings[0].message.includes('EDup')
);

assert(
  'single-line functions with UNIQUE codes must not be flagged (no false positive from the fix)',
  check(singleLineUnique, 's.move').length === 0
);

if (errs.length) {
  console.log(`${errs.length} case(s) failed:`);
  for (const e of errs) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('MOV-006 detects a shared abort code in both single-line and multi-line function bodies');
process.exit(0);
