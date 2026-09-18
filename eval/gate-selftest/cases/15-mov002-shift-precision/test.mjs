#!/usr/bin/env node
/**
 * MOV-002's bit-shift sub-check (shipped v1.6.0, ae41b55) was wrong in both
 * directions:
 *
 * FAIL-OPEN: its "type annotation, not arithmetic" guard checked only the
 * text BEFORE the first `:` in the line for a shift operator
 * (`trimmed.split(':')[0]`) -- for a single-line function body
 * (`fun f(a: u64): u64 { a << b }`), the real shift always sits AFTER
 * every type-annotation colon, so this guard was true on every such line
 * and skipped it outright, whatever the body contained.
 *
 * FALSE POSITIVE: `>>` was flagged with the same "silently wraps on
 * overflow" message as `<<`, but (a) two closing generic brackets
 * (`vector<vector<u8>>`, `VecMap<K, VecSet<V>>`) also produce a literal
 * `>>` with no shift anywhere nearby -- the single largest source of the
 * v1.5.2->v1.6.0 corpus explosion -- and (b) even a REAL right shift
 * cannot "wrap on overflow": it discards LOW bits by design (unscaling,
 * division-by-power-of-two), the message was simply false for it.
 *
 * Fix: `>>` is no longer flagged at all (see the rule file's own comment
 * for the full reasoning) -- this also removes the generic-bracket false
 * positive as a structural consequence, not a separate patch. `<<` is
 * flagged on ANY line containing it, not gated behind a colon-position
 * heuristic, and Move's generic syntax cannot produce a literal `<<`
 * (nested opens are never adjacent -- `A<B<C>>`, not `A<<...`), so no
 * equivalent guard is needed for it.
 */
import { check } from '../../../../rules/mov-002-unchecked-arithmetic.mjs';

const errs = [];
function assert(label, cond) {
  if (!cond) errs.push(label);
}

// ── FAIL-OPEN repro: single-line `<<` body ──
const singleLineShl = `
module d::a {
    public fun shl(amt: u64, bits: u8): u64 { amt << bits }
}`;
const shlFindings = check(singleLineShl, 'a.move');
assert(
  'a single-line function body containing << must be flagged (was: silent)',
  shlFindings.length === 1 && /<</.test(shlFindings[0].message)
);

// ── FALSE POSITIVE repro: nested generics read as a shift ──
const nestedGeneric = `
module d::b {
    public fun store(x: vector<vector<u8>>) { }
}`;
assert(
  'vector<vector<u8>> must not be flagged -- >> here is two closing brackets',
  check(nestedGeneric, 'b.move').length === 0
);

const nestedGeneric2 = `
module d::b2 {
    public struct Registry has key { id: UID, m: VecMap<vector<u8>, VecSet<address>> }
}`;
assert(
  'VecMap<vector<u8>, VecSet<address>> must not be flagged either',
  check(nestedGeneric2, 'b2.move').length === 0
);

// ── WRONG MESSAGE repro: a real right shift must not be flagged, since
// ── the design call is to drop >> entirely rather than assert a false
// ── "wraps on overflow" claim it structurally cannot have ──
const rightShift = `
module d::c {
    public fun shr(a: u64): u64 {
        a >> 3
    }
}`;
assert(
  'a genuine right shift must not be flagged (>> cannot overflow/wrap)',
  check(rightShift, 'c.move').length === 0
);

// ── control: a multi-line << shift must still be flagged ──
const multiLineShl = `
module d::e {
    public fun shl2(a: u64, b: u8): u64 {
        a << b
    }
}`;
assert(
  'a multi-line << shift must still be flagged (control, pre-existing behaviour)',
  check(multiLineShl, 'e.move').length === 1
);

// ── control: a compile-time const shift must stay exempt ──
const constShift = `
module d::f {
    const MASK: u64 = 1 << 63;
}`;
assert(
  'a const declaration computed with << must stay exempt (compile-time, no runtime risk)',
  check(constShift, 'f.move').length === 0
);

// ── control: the multiplication sub-check is untouched by this fix ──
const mulUnsafe = `
module d::g {
    public fun mul(a: u64, b: u64): u64 {
        a * b
    }
}`;
assert(
  'the multiplication sub-check must still fire (out of scope for this fix)',
  check(mulUnsafe, 'g.move').length === 1
);

if (errs.length) {
  console.log(`${errs.length} case(s) failed:`);
  for (const e of errs) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('MOV-002 bit-shift check: << fires precisely (incl. single-line bodies), >> never fires');
process.exit(0);
