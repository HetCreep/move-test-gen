/**
 * Selftest for --scope filter: when scope is set, only target files get mutated.
 * Uses the gate's runMutations indirectly by checking output text.
 *
 * Strategy: create a mini scenario with two source files (target.move + dep.move),
 * run gate with --scope target.move, verify output mentions only target.move mutations.
 * Since we can't run sui here, we test the scope filtering logic directly.
 */
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const GATE = join(repoRoot, 'scripts', 'check-coverage.mjs');

// gate-selftest cases 01 has sources with 11 asserts — run it with --scope
// to verify scope filtering on Layer 1 output (Layer 2 needs sui, so L1 only)
const case01 = join(here, '..', '01-gauntlet');

const errs = [];
function check(label, cond) {
  if (!cond) errs.push(label);
}

// Run gate WITHOUT scope — should find 11 asserts
const r1 = spawnSync(process.execPath, [GATE, join(case01, 'sources'), join(case01, 'tests')], {
  encoding: 'utf8', timeout: 30000,
});
const out1 = (r1.stdout || '') + (r1.stderr || '');
const asserts1 = out1.match(/Asserts found:\s+(\d+)/);
check('no-scope finds 11 asserts', asserts1 && Number(asserts1[1]) === 11);

// Run gate WITH --scope nonexistent.move — pre-scope assert count unchanged,
// but Layer 1 scoped count shows 0 target asserts
const r2 = spawnSync(process.execPath, [GATE, join(case01, 'sources'), join(case01, 'tests'), '--scope', 'nonexistent.move'], {
  encoding: 'utf8', timeout: 30000,
});
const out2 = (r2.stdout || '') + (r2.stderr || '');
const asserts2 = out2.match(/Asserts found:\s+(\d+)/);
check('pre-scope assert count unchanged with --scope', asserts2 && Number(asserts2[1]) === 11);

// A --scope list that matches no source file is a usage error, not a verdict:
// nothing was measured, so "the gate failed" would be the wrong signal. It exits
// 2 under the exit-code contract agreed in #19. This case previously accepted
// 0 or 1, which its own comment admits was looser than intended.
check('scope matching no file exits 2 (usage error)', r2.status === 2);

if (errs.length) {
  console.log('FAIL:');
  for (const e of errs) console.log(`  ✗ ${e}`);
  process.exit(1);
} else {
  console.log('scope-filter selftest: all checks passed');
  process.exit(0);
}
