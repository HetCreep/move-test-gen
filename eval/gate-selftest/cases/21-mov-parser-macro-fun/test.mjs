#!/usr/bin/env node
/**
 * WAVE 3 UNIT 2 (U5) -- move-parser.mjs's function regex had no `macro`
 * alternative, so `public macro fun`/`macro fun`/`public(package) macro
 * fun` were never modelled: parseModule() returned zero functions for a
 * file containing only a macro, and every parser-backed rule (MOV-002,
 * MOV-004, MOV-008, MOV-011 -- confirmed via `grep -l move-parser
 * rules/*.mjs`, exactly those four) saw nothing inside a macro's body.
 * Disclosed as a known blind spot in PR #85's own body; this unit closes
 * it with ONE regex alternative, re-arming all four rules at once.
 *
 * LEGALITY CHECK (source-grounded, move-book.com/move-basics/macros/,
 * quoted): "A macro function looks and feels like a regular function, but
 * it does not exist at runtime. Instead, the compiler expands the macro:
 * at every call site, the body of the macro is substituted inline..."
 * `entry` marks a function as directly PTB-invocable at the RUNTIME
 * level -- a macro has no runtime existence for that marker to attach to,
 * so `entry` on a macro is illegal. MOV-011 (the public(package)-entry
 * bypass rule) is therefore pinned on its NEAREST LEGAL shapes instead of
 * an illegal macro+entry combination: it must NOT fire on a legal
 * `public(package) macro fun` (no entry, no PTB-callable surface, no
 * bypass to detect), and it must still fire, unaffected, on a plain
 * `public(package) entry fun` (a regression guard proving this unit
 * didn't touch MOV-011's real detection).
 *
 * Also fixed, disclosed rather than silently left broken: `parseParams`'s
 * `<>`-depth comma-splitter treated the bare `>` in a macro lambda
 * param's `->` (`$f: |u64| -> u64`) as closing a generic it never opened,
 * driving depth negative and silently swallowing the NEXT real top-level
 * comma into the current param's text -- a two-param macro signature
 * parsed as one garbled param. Fixed with a one-line clamp
 * (`depth > 0` before decrementing), not pipe-aware parsing: a macro
 * with MULTIPLE lambda params sharing one `|a, b| -> c` signature (an
 * internal comma INSIDE the pipes) is NOT covered by this clamp and
 * remains a known, disclosed residual limit -- fixing that would need
 * pipe-delimiter tracking, a second alternative beyond this unit's scope.
 */
import { parseModule } from '../../../../scripts/move-parser.mjs';
import { check as check002 } from '../../../../rules/mov-002-unchecked-arithmetic.mjs';
import { check as check004 } from '../../../../rules/mov-004-unsafe-downcast.mjs';
import { check as check008 } from '../../../../rules/mov-008-exact-equality-assert.mjs';
import { check as check011 } from '../../../../rules/mov-011-package-entry-bypass.mjs';

const errs = [];
function assert(label, cond) {
  if (!cond) errs.push(label);
}

// ── MOV-002: unpromoted a * b inside a macro body ──────────────────────
const macroMul = `
module d::m {
    public macro fun scale($a: u64, $b: u64): u64 {
        let a = $a;
        let b = $b;
        a * b
    }
}`;
assert('MOV-002 fires on an unpromoted a * b inside a macro body', check002(macroMul, 'm.move').length === 1);

// ── MOV-004: (w as u64) downcast inside a macro body ───────────────────
const macroDowncast = `
module d::m {
    public macro fun narrow($w: u128): u64 {
        let w = $w;
        (w as u64)
    }
}`;
assert('MOV-004 fires on a downcast inside a macro body', check004(macroDowncast, 'm.move').length === 1);

// ── MOV-008: exact-equality payment assert inside a macro body ─────────
const macroPayment = `
module d::m {
    public macro fun settle($payment: u64, $required: u64) {
        assert!($payment == $required, 1);
    }
}`;
assert('MOV-008 fires on an exact-equality payment assert inside a macro body', check008(macroPayment, 'm.move').length === 1);

// ── MOV-011: entry+macro is illegal Move -- pinned on the nearest legal
// shapes instead (see the docstring's legality check) ──────────────────
const macroPackageNoEntry = `
module d::m {
    public(package) macro fun helper($a: u64): u64 { $a }
}`;
assert(
  'MOV-011 does NOT fire on a legal public(package) macro (no entry -- macros have no runtime PTB surface to bypass)',
  check011(macroPackageNoEntry, 'm.move').length === 0
);
const plainPackageEntry = `
module d::m {
    public(package) entry fun reset_pool(pool: &mut Pool) { }
}`;
assert(
  'MOV-011 still fires on a plain public(package) entry fun -- regression guard, unaffected by this unit',
  check011(plainPackageEntry, 'm.move').length === 1
);

// ── Negative: a macro whose body is genuinely clean stays clean ────────
const macroClean = `
module d::m {
    public macro fun identity($x: u64): u64 {
        $x
    }
}`;
assert('MOV-002 stays silent on a clean macro body', check002(macroClean, 'm.move').length === 0);
assert('MOV-004 stays silent on a clean macro body', check004(macroClean, 'm.move').length === 0);

// ── Negative: a $-parameter signature parses without inventing a
// phantom function, and correctly splits a lambda-typed param from the
// next one (the dispatch's own example) ────────────────────────────────
const macroLambda = `
module d::m {
    public macro fun apply($f: |u64| -> u64, $x: u64): u64 {
        $f($x)
    }
}`;
const parsedLambda = parseModule(macroLambda);
assert('a $-prefixed lambda-param signature parses exactly one function (no phantom)', parsedLambda.functions.length === 1);
assert(
  'the lambda-typed param and the following param split correctly (2 params, not 1 garbled)',
  parsedLambda.functions[0]?.params.length === 2
);
assert('parseModule marks the function isMacro: true', parsedLambda.functions[0]?.isMacro === true);

// ── Negative: bare (no-visibility) macro and public(package) macro both
// parse as exactly one function ─────────────────────────────────────────
const bareMacro = `
module d::m {
    macro fun helper($a: u64): u64 { $a }
}`;
assert('a bare (private) macro parses as exactly one function', parseModule(bareMacro).functions.length === 1);
assert('public(package) macro parses as exactly one function', parseModule(macroPackageNoEntry).functions.length === 1);

// ── Regression: a plain (non-macro) function with the identical body
// still fires the same findings as before this unit ─────────────────────
const plainTwin = `
module d::m {
    public fun scale(a: u64, b: u64): u64 {
        let m = a * b;
        (m as u64)
    }
}`;
assert('MOV-002 still fires on the plain-fun twin (unaffected regression)', check002(plainTwin, 'm.move').length === 1);
assert('MOV-004 still fires on the plain-fun twin (unaffected regression)', check004(plainTwin, 'm.move').length === 1);

if (errs.length) {
  console.log('FAIL:');
  for (const e of errs) console.log(`  ✗ ${e}`);
  process.exit(1);
}
console.log('macro fun re-arms MOV-002/004/008/011 (entry+macro is illegal Move, MOV-011 pinned on its nearest legal shapes); $-params and a lambda-typed param split correctly; a clean macro body and a plain-fun twin are both unaffected');
process.exit(0);
