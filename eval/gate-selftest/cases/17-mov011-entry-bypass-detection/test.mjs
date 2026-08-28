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
 */
import { check } from '../../../../rules/mov-011-package-entry-bypass.mjs';

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

if (errs.length) {
  console.log(`${errs.length} case(s) failed:`);
  for (const e of errs) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('MOV-011 catches attribute-prefixed and multi-line-wrapped entry bypasses; negative controls stay silent');
process.exit(0);
