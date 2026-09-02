#!/usr/bin/env node
/**
 * WAVE 3 UNIT 1 -- "the tool could not read the source, and reported CLEAN"
 * is one class with two instances, fixed at the mechanism, never by
 * changing a rule file:
 *
 * U1: a whitespace-collapsed one-line module made parseModule()'s
 *     extractFunctions() return zero functions -- its signature regex was
 *     anchored to the START of a trimmed line, so a `module d::m { public
 *     fun f(...) { ... } }` packed onto one physical line never matched.
 *     Fixed by un-anchoring the regex (a strict superset: every existing
 *     multi-line signature still matches at the same position, since
 *     nothing precedes it there to try first).
 *
 *     This fixes every PARSER-BACKED rule (MOV-002, MOV-004, MOV-008,
 *     MOV-011). MOV-001 does NOT use move-parser.mjs at all -- it is its
 *     own independent, separately anchored line-scanner -- and STAYS BLIND
 *     on the one-line form. That is pinned below as a KNOWN LIMITATION,
 *     not silently dropped: fixing it needs rules/mov-001-*.mjs, out of
 *     this unit's scope by the dispatch's own rails.
 *
 * U2: an unterminated `/*` made strip-comments.mjs blank everything from
 *     there to EOF with no signal that anything was wrong -- the rules
 *     then scanned an effectively empty file and reported "No findings."
 *     Fixed by adding hasUnterminatedBlockComment() (sharing strip-
 *     comments.mjs's existing scan state machine, never duplicating it)
 *     and wiring lint.mjs's runLint() to report an `unreadable` entry per
 *     such file instead of running any rule against blanked garbage. The
 *     CLI decides the exit code (library/CLI split unchanged): exit 3 per
 *     README's own table ("the tool could not run and produced no
 *     verdict"), UNLESS a real finding exists elsewhere in the same run,
 *     in which case README's own precedence ("a defect outranks a missing
 *     tool") makes exit 1 win.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { runLint } from '../../../../scripts/lint.mjs';
import { check as check002 } from '../../../../rules/mov-002-unchecked-arithmetic.mjs';
import { check as check004 } from '../../../../rules/mov-004-unsafe-downcast.mjs';
import { check as check011 } from '../../../../rules/mov-011-package-entry-bypass.mjs';
import { check as check001 } from '../../../../rules/mov-001-missing-access-control.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const LINT_CLI = join(repoRoot, 'scripts', 'lint.mjs');

const errs = [];
function assert(label, cond) {
  if (!cond) errs.push(label);
}

// ── U1: one-line module vs its multi-line twin, same source ───────────

const oneLine = `module d::m { public(package) entry fun drain(v: &mut Vault, a: u64, b: u64, w: u128) { let m = a * b; let n = (w as u64); assert!(a == b, 1); v.bal = 0; } }`;

const multiLine = `module d::m {
    public(package) entry fun drain(v: &mut Vault, a: u64, b: u64, w: u128) {
        let m = a * b;
        let n = (w as u64);
        assert!(a == b, 1);
        v.bal = 0;
    }
}`;

for (const [label, check] of [['MOV-002', check002], ['MOV-004', check004], ['MOV-011', check011]]) {
  const oneLineFires = check(oneLine, 'm.move').length > 0;
  const multiLineFires = check(multiLine, 'm.move').length > 0;
  assert(
    `${label} must fire on the one-line module (fires on its multi-line twin: ${multiLineFires})`,
    multiLineFires && oneLineFires
  );
}

// MOV-001 is a KNOWN LIMITATION here, not a bug this unit introduced or
// hid: it never routes through move-parser.mjs, so a mechanism fix there
// cannot reach it. Pinned so a future "why doesn't MOV-001 fire here" is
// answered by this test, not by re-discovering the same fact.
assert(
  'MOV-001 (independent of move-parser.mjs) fires on the multi-line twin',
  check001(multiLine, 'm.move').length > 0
);
assert(
  'KNOWN LIMITATION: MOV-001 does NOT fire on the one-line form -- it has its own anchored scanner, untouched by this unit (out of scope; would need rules/mov-001-*.mjs)',
  check001(oneLine, 'm.move').length === 0
);

// ── U2: unterminated /* -- library level (runLint's `unreadable`) ─────

function makeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-unparseable-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const UNTERMINATED = `module d::m {
/* unterminated
    public fun f(a: u64, b: u64) { let z = a * b; }
}
`;

const EMPTY = '';

const COMMENT_ONLY = `/* a fully terminated block comment */
// and a line comment too
`;

const NORMAL_CLEAN = `module d::v {
    public fun total(p: &Pool): u64 {
        p.total
    }
}
`;

const NORMAL_FINDING = `module d::h {
    public fun drain(v: &mut Pool, amount: u64) {
        v.total = amount;
    }
}
`;

// A pre-fix runLint() has no `unreadable` field at all -- these calls are
// wrapped so that shape mismatch reports as a failed assertion (useful
// red-first signal) rather than an uncaught crash that hides every
// assertion after it.
async function runLintSafe(dir) {
  try {
    return await runLint(dir);
  } catch (e) {
    return { findings: [], unreadable: undefined, _crashed: e.message };
  }
}

{
  const dir = makeDir({ 'a.move': UNTERMINATED });
  const { findings, unreadable, _crashed } = await runLintSafe(dir);
  assert('an unterminated block comment produces zero fabricated findings', findings.length === 0);
  assert(
    `runLint() names the file as unreadable${_crashed ? ` (crashed: ${_crashed})` : ''}`,
    Array.isArray(unreadable) && unreadable.length === 1 && unreadable[0].file.endsWith('a.move')
  );
  assert(
    'the unreadable reason mentions the unterminated block comment',
    Array.isArray(unreadable) && unreadable.length === 1 && /unterminated/i.test(unreadable[0].reason || '')
  );
}

{
  const dir = makeDir({ 'a.move': EMPTY });
  const { unreadable } = await runLintSafe(dir);
  assert('a legitimately EMPTY file must NOT be called unreadable', Array.isArray(unreadable) && unreadable.length === 0);
}

{
  const dir = makeDir({ 'a.move': COMMENT_ONLY });
  const { unreadable } = await runLintSafe(dir);
  assert('a comment-only (fully terminated) file must NOT be called unreadable', Array.isArray(unreadable) && unreadable.length === 0);
}

// ── U2: exit codes -- CLI level (spawn the real gate) ──────────────────

const spawnLint = (dir) => spawnSync(process.execPath, [LINT_CLI, dir], { encoding: 'utf8', timeout: 30000 });

{
  const dir = makeDir({ 'a.move': UNTERMINATED });
  const r = spawnLint(dir);
  assert(`an unreadable-only run exits 3 (got ${r.status})`, r.status === 3);
  assert('the CLI names the unreadable file in its output', /a\.move/.test((r.stdout || '') + (r.stderr || '')));
}

{
  const dir = makeDir({ 'a.move': NORMAL_CLEAN });
  const r = spawnLint(dir);
  assert(`a normal clean file still exits 0 (got ${r.status})`, r.status === 0);
}

{
  // Precedence: a real finding elsewhere in the SAME run outranks an
  // unreadable file -- README's own rule ("a defect outranks a missing
  // tool"), applied to this new path. Exit 1, never 3.
  const dir = makeDir({ 'clean.move': NORMAL_FINDING, 'broken.move': UNTERMINATED });
  const r = spawnLint(dir);
  assert(`a real finding outranks an unreadable file in the same run: exits 1, not 3 (got ${r.status})`, r.status === 1);
}

if (errs.length) {
  console.log('FAIL:');
  for (const e of errs) console.log(`  ✗ ${e}`);
  process.exit(1);
}
console.log('unparseable source no longer reads as clean: one-line module fires MOV-002/004/011 (MOV-001 stays a documented gap), unterminated /* gets an unreadable verdict and exit 3, empty/comment-only files stay clean, a real finding outranks an unreadable file');
process.exit(0);
