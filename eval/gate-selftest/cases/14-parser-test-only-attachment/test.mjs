#!/usr/bin/env node
/**
 * move-parser.mjs's extractFunctions() used to decide #[test_only]/#[test]
 * with a blind 3-line backward lookback: any attribute within 3 lines of a
 * function marked it test-only, whoever it was actually attached to. A
 * module-level `#[test_only]\nuse sui::test_scenario;` at the top of a file
 * would leak onto the next real function and silence MOV-002/MOV-004 for it
 * (fail-open — the exact class of bug this tool exists to catch).
 *
 * The fix makes attachment boundary-based: an attribute belongs to the item
 * directly below it (skipping only blank lines, comments, and stacked
 * attributes), and is discarded the instant a real item (`use`, `struct`,
 * `const`, or a `fun` that doesn't consume it) is reached.
 *
 * This pins both directions: the leak must not happen, AND a genuinely
 * test-only function -- multi-line or same-line attribute form -- must
 * still be exempt.
 */
import { check as checkMov002 } from '../../../../rules/mov-002-unchecked-arithmetic.mjs';
import { check as checkMov004 } from '../../../../rules/mov-004-unsafe-downcast.mjs';

const errs = [];
function assert(label, cond) {
  if (!cond) errs.push(label);
}

// ── the leak: a #[test_only] use at module top must NOT reach mul_it ──
const leak = `
module example::leak {
    #[test_only]
    use sui::test_scenario;

    public fun mul_it(a: u64, b: u64): u64 {
        a * b
    }

    public fun down_it(x: u128): u64 {
        (x as u64)
    }
}`;

const leakMov002 = checkMov002(leak, 'leak.move');
assert(
  'MOV-002 must fire on mul_it -- the #[test_only] use above it must not leak onto it',
  leakMov002.length === 1
);

const leakMov004 = checkMov004(leak, 'leak.move');
assert(
  'MOV-004 must still fire on down_it (control -- was never affected by the leak)',
  leakMov004.length === 1
);

// ── the legitimate case: multi-line #[test_only] directly above a fun ──
const legitMultiline = `
module example::legit_multiline {
    #[test_only]
    public fun mul_helper(a: u64, b: u64): u64 {
        a * b
    }
}`;
assert(
  'a genuine multi-line #[test_only] fun must stay exempt from MOV-002',
  checkMov002(legitMultiline, 'legit.move').length === 0
);

// ── the legitimate case: same-line #[test_only] fun ──
const legitSameLine = `
module example::legit_sameline {
    #[test_only] public fun mul_helper2(a: u64, b: u64): u64 {
        a * b
    }
}`;
assert(
  'a genuine same-line "#[test_only] fun ..." must stay exempt from MOV-002',
  checkMov002(legitSameLine, 'legit.move').length === 0
);

// ── the legitimate case: same-line #[test_only] use must not leak either ──
const legitSameLineUse = `
module example::legit_sameline_use {
    #[test_only] use sui::test_scenario;

    public fun mul_it(a: u64, b: u64): u64 {
        a * b
    }
}`;
assert(
  'a same-line "#[test_only] use ...;" must not leak onto the next function',
  checkMov002(legitSameLineUse, 'legit.move').length === 1
);

if (errs.length) {
  console.log(`${errs.length} case(s) failed:`);
  for (const e of errs) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('#[test_only]/#[test] attachment is boundary-based: no leak, exemptions intact');
process.exit(0);
