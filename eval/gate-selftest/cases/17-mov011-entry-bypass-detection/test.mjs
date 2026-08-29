#!/usr/bin/env node
/**
 * MOV-011's check() used to be a single anchored-line regex:
 * `/^public\s*\(\s*(?:package|friend)\s*\)\s+entry\s+fun\b/` against one
 * `trimmed` line. Two shapes produced zero findings while the vulnerable
 * declaration was fully present:
 *
 * 1. A same-line attribute before the modifier (`#[allow(...)]
 *    public(package) entry fun f(...)`) -- the `^` anchor fails because
 *    the line starts with `#[`, not `public`.
 * 2. The declaration split across lines (`public(package)` on one line,
 *    `entry fun f(` on the next, or wrapped params) -- nothing reassembles
 *    the signature, so the single-line test never sees the whole thing.
 *
 * The premise is not in question here -- `entry` makes a function a PTB
 * transaction target regardless of `public(package)`/`public(friend)`,
 * which is a genuine fail-open access-control bypass. The bug is purely
 * that detection missed these two shapes.
 *
 * Fixed by moving detection onto the shared Move parser
 * (scripts/move-parser.mjs), which already does function-signature
 * reassembly for wrapped parameter lists and same-line attributes for
 * other rules. Extended there (not special-cased in this rule) to also
 * recognise `public(package) entry` / `public(friend) entry` as their own
 * visibility values, including when the leading `public(package)`/`entry`
 * tokens sit on a line of their own with nothing else on it.
 *
 * That extension activated a pre-existing, previously-inert parser bug:
 * the parameter collector treated the FIRST `(` on the signature line as
 * the start of the parameter list, and `public(package)`/`public(friend)`
 * carry their own balanced paren pair before the real one. At origin/main
 * this never fired for these functions -- the old fnRegex had no
 * alternative that matched `public(package) entry` at all, so
 * parseFunctionSignature() returned null and they were invisible to every
 * parser-backed rule. This branch's own new alternative made them
 * visible, and the empty `params` flowed into MOV-002, which uses
 * `getVarType()` on params to recognise an already-u128-promoted operand
 * -- with no params, that check can never fire, and an already-safe
 * `u128 * u128` multiply reported as unpromoted. Fixed by starting the
 * parameter scan at the paren fnRegex's own match ends on (available from
 * the match object), not at the first `(` in the line -- skips any
 * visibility-modifier parens before it, for every `public(package)`/
 * `public(friend)` form, entry or not.
 *
 * A #[test_only] helper was also flagged HIGH -- never deployed, so this
 * was a false positive MOV-002/MOV-004 already avoid via the same
 * fn.isTest/fn.isTestOnly flags the parser sets. MOV-011 now checks them.
 */
import { check } from '../../../../rules/mov-011-package-entry-bypass.mjs';
import { check as checkMov002 } from '../../../../rules/mov-002-unchecked-arithmetic.mjs';
import { parseModule } from '../../../../scripts/move-parser.mjs';

const errs = [];
function assert(label, cond) {
  if (!cond) errs.push(label);
}

// ── bypass 1: same-line attribute before the modifier ──
const sameLineAttr = `module d::a {
    #[allow(lint(self_transfer))] public(package) entry fun bypass1(cap: &AdminCap) {
        abort 0
    }
}`;
assert(
  'a same-line attribute before public(package) entry must not hide the finding',
  check(sameLineAttr, 'a.move').length === 1
);

// ── bypass 2: declaration split across lines ──
const splitLines = `module d::b {
    public(package)
    entry fun bypass2(
        cap: &AdminCap
    ) {
        abort 0
    }
}`;
assert(
  'a public(package)/entry declaration wrapped across lines must not hide the finding',
  check(splitLines, 'b.move').length === 1
);

// ── the plain, single-line, unattributed form must still fire ──
const plainPackageEntry = `module d::c {
    public(package) entry fun bypass3(x: u64) { abort 0 }
}`;
assert(
  'the plain public(package) entry form must still be flagged (control)',
  check(plainPackageEntry, 'c.move').length === 1
);

const plainFriendEntry = `module d::c2 {
    public(friend) entry fun bypass4(x: u64) { abort 0 }
}`;
assert(
  'the legacy public(friend) entry form must still be flagged',
  check(plainFriendEntry, 'c2.move').length === 1
);

// ── negative controls: none of these are this defect ──
const entryAlone = `module d::e {
    entry fun ok1(x: u64) { abort 0 }
}`;
assert(
  'entry alone (no package/friend restriction) is an intentional entrypoint, not this defect',
  check(entryAlone, 'e.move').length === 0
);

const packageAlone = `module d::f {
    public(package) fun ok2(x: u64) { abort 0 }
}`;
assert(
  'public(package) alone (no entry) is genuinely package-scoped, not this defect',
  check(packageAlone, 'f.move').length === 0
);

const friendAlone = `module d::f2 {
    public(friend) fun ok3(x: u64) { abort 0 }
}`;
assert(
  'public(friend) alone (no entry) is genuinely restricted, not this defect',
  check(friendAlone, 'f2.move').length === 0
);

const insideLineComment = `module d::g {
    // public(package) entry fun ok4(x: u64) { abort 0 }
    public fun ok4(x: u64) { x }
}`;
assert(
  'the shape inside a // comment must not fire',
  check(insideLineComment, 'g.move').length === 0
);

const insideBlockComment = `module d::h {
    /*
    public(package) entry fun ok5(x: u64) { abort 0 }
    */
    public fun ok5(x: u64) { x }
}`;
assert(
  'the shape inside a /* */ block comment must not fire',
  check(insideBlockComment, 'h.move').length === 0
);

const insideStringLiteral = `module d::i {
    public fun ok6(): vector<u8> {
        b"public(package) entry fun bypass(x: u64) { abort 0 }"
    }
}`;
assert(
  'the shape inside a string literal must not fire',
  check(insideStringLiteral, 'i.move').length === 0
);

// ── the param bug this fix activated, now closed: a public(package)
// ── entry function's params must be parsed, not swallowed by the
// ── visibility modifier's own parens ──
const packageEntryParams = `module d::j {
    public(package) entry fun paramCheck(a: u128, b: u128) { a * b; }
}`;
const parsedParams = parseModule(packageEntryParams).functions[0].params;
assert(
  'a public(package) entry function must have its real params parsed, not swallowed by the visibility parens',
  parsedParams.length === 2 &&
  parsedParams[0].name === 'a' && parsedParams[0].type === 'u128' &&
  parsedParams[1].name === 'b' && parsedParams[1].type === 'u128'
);

// ── the MOV-002 false positive this activated: an already-u128-promoted
// ── multiply inside a public(package) entry function must not fire ──
const packageEntryMul = `module d::k {
    public(package) entry fun safeMul(a: u128, b: u128): u128 {
        a * b
    }
}`;
assert(
  'MOV-002 must not flag an already-promoted u128*u128 multiply just because the function is public(package) entry',
  checkMov002(packageEntryMul, 'k.move').length === 0
);

const plainPublicMul = `module d::l {
    public fun safeMulPlain(a: u128, b: u128): u128 {
        a * b
    }
}`;
assert(
  'the same body under plain public must also stay silent (control, must match origin/main)',
  checkMov002(plainPublicMul, 'l.move').length === 0
);

// ── the #[test_only] false positive: a test-only helper is never
// ── deployed and must not be flagged ──
const testOnlyHelper = `module d::m {
    #[test_only]
    #[allow(lint(self_transfer))]
    public(package) entry fun test_helper(x: u64) { abort 0 }
}`;
assert(
  'a #[test_only] public(package) entry helper must not be flagged -- never deployed',
  check(testOnlyHelper, 'm.move').length === 0
);

if (errs.length) {
  console.log(`${errs.length} case(s) failed:`);
  for (const e of errs) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('MOV-011 catches attribute-prefixed and multi-line-wrapped entry bypasses; negative controls stay silent; the activated param/test-only bugs stay closed');
process.exit(0);
