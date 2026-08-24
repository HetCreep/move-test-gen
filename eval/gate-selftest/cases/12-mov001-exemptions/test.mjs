#!/usr/bin/env node
/**
 * MOV-001 skips a set of function names on purpose (checkFunction()'s name
 * checks, in rules/mov-001-missing-access-control.mjs).
 * Nothing pinned that, so the list could be widened or narrowed by accident and
 * no test would notice — and a widened exemption list is a silent gate bypass.
 *
 * This also pins the documented limitation that the exemption is name-based:
 * `init` is skipped whatever it does.
 */
import { check } from '../../../../rules/mov-001-missing-access-control.mjs';

const body = '(v: &mut Pool, amount: u64) { v.total = amount; }';
const cases = [
  ['init',            false, 'module initialiser, exempt by name'],
  ['test_drain',      false, 'test_ prefix, exempt'],
  ['drain_test',      false, 'to_test suffix, exempt'],
  ['destroy_pool',    false, 'destroy in the name, exempt'],
  ['testing_helper',  false, 'testing in the name, exempt'],
  ['drain',           true,  'ordinary public fun, must be flagged'],
  ['withdraw_all',    true,  'ordinary public fun, must be flagged'],
];

// word-boundary regression: "PositionManager" (shared object) was falsely
// exempt because /Position/ matched as a substring — only exact "Position"
// (user-owned NFT) should be exempt
const managerBody = '(pm: &mut PositionManager, amount: u64) { }';
const positionBody = '(pos: &mut Position, amount: u64) { }';
const wbCases = [
  ['spec_call_pull',  managerBody, true,  'PositionManager is a shared object, must be flagged'],
  ['rebalance',       positionBody, false, 'Position (exact) is a user-owned NFT, exempt'],
];

let failed = 0;
for (const [name, shouldFlag, why] of cases) {
  const src = `module demo::m {\n    public fun ${name}${body}\n}\n`;
  const findings = check(src, 'demo.move').filter(f => f.rule === 'MOV-001');
  const flagged = findings.length > 0;
  if (flagged !== shouldFlag) {
    failed++;
    console.log(`  ${name}: expected ${shouldFlag ? 'FLAGGED' : 'exempt'}, got ${flagged ? 'FLAGGED' : 'exempt'} — ${why}`);
  }
}

for (const [name, body2, shouldFlag, why] of wbCases) {
  const src = `module demo::m {\n    public fun ${name}${body2}\n}\n`;
  const findings = check(src, 'demo.move').filter(f => f.rule === 'MOV-001');
  const flagged = findings.length > 0;
  if (flagged !== shouldFlag) {
    failed++;
    console.log(`  ${name}: expected ${shouldFlag ? 'FLAGGED' : 'exempt'}, got ${flagged ? 'FLAGGED' : 'exempt'} — ${why}`);
  }
}

if (failed) {
  console.log(`${failed} exemption(s) changed behaviour`);
  process.exit(1);
}
console.log('MOV-001 exemption list unchanged (incl. word-boundary fix)');
process.exit(0);
