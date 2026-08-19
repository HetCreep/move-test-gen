import { stripBlockComments } from "./strip-comments.mjs";
/**
 * lint.mjs — security lint engine for Sui Move source code.
 *
 * Loads rules from rules/ directory, runs each against every .move file
 * in the given sources directory, reports findings grouped by severity.
 *
 * Rules are pure functions: (source, filename) → findings[].
 * Each rule is a standalone .mjs file with check() and meta exports.
 * No Move compiler needed — regex-based pattern detection.
 *
 * Usage (standalone):
 *   node scripts/lint.mjs <sources-dir>
 *
 * Usage (via check-coverage.mjs):
 *   node scripts/check-coverage.mjs <sources> <tests> --lint
 */

import { readdirSync, readFileSync } from 'fs';
import { join, resolve, relative, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { walkDir } from './walk-dir.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(here, '..', 'rules');

/**
 * Run all lint rules against source files.
 * @param {string} sourcesDir
 * @returns {Promise<{findings: Array, ruleCount: number}>}
 */
const VALID_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/**
 * A rule that ships without its id or severity is worse than a missing rule:
 * it runs, produces findings the reporter cannot group, and nothing says so.
 * Fail at load, naming the file, rather than at some later `undefined`.
 */
export function validateRule(mod, file) {
  const problems = [];
  if (typeof mod.check !== 'function') problems.push('no exported check() function');
  const meta = mod.meta;
  if (!meta || typeof meta !== 'object') {
    problems.push('no exported meta object');
  } else {
    if (!meta.id) problems.push('meta.id is missing');
    if (!meta.title) problems.push('meta.title is missing');
    if (!meta.severity) problems.push('meta.severity is missing');
    else if (!VALID_SEVERITIES.includes(String(meta.severity).toUpperCase())) {
      problems.push(`meta.severity "${meta.severity}" is not one of ${VALID_SEVERITIES.join(', ')}`);
    }
  }
  if (problems.length) {
    throw new Error(`rules/${file} is not a valid rule: ${problems.join('; ')}`);
  }
}


const DISABLE_FILE_RE = /^\s*\/\/\s*move-test-gen-disable\s+(.+?)\s*$/;
const DISABLE_NEXT_RE = /^\s*\/\/\s*move-test-gen-disable-next-line\s+(.+?)\s*$/;

const parseRuleList = (raw) =>
  raw.split(',').map(r => r.trim().toUpperCase()).filter(Boolean);

/**
 * Read the suppression comments out of one file.
 *
 * A comment pragma rather than a Move attribute: `#[allow(lint(...))]` is the
 * compiler's namespace, not ours, so an unknown attribute there risks a warning
 * from `sui move build`, while a comment stays invisible to it.
 */
export function parseSuppressions(source) {
  const lines = source.split('\n');
  const file = new Set();
  const byLine = new Map();
  for (let i = 0; i < lines.length; i++) {
    const nextMatch = lines[i].match(DISABLE_NEXT_RE);
    if (nextMatch) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('//')) continue;
        const set = byLine.get(j + 1) || new Set();
        for (const r of parseRuleList(nextMatch[1])) set.add(r);
        byLine.set(j + 1, set);
        break;
      }
      continue;
    }
    const fileMatch = lines[i].match(DISABLE_FILE_RE);
    if (fileMatch) for (const r of parseRuleList(fileMatch[1])) file.add(r);
  }
  return { file, byLine };
}

/** Suppressed by this file's own pragmas, or by a run-wide --disable? */
export function isSuppressed(finding, suppressions, disabled) {
  const rule = String(finding.rule || '').toUpperCase();
  if (disabled.has(rule)) return true;
  if (suppressions.file.has(rule)) return true;
  const atLine = suppressions.byLine.get(finding.line);
  return Boolean(atLine && atLine.has(rule));
}
export async function runLint(sourcesDir, options = {}) {
  const disabled = new Set((options.disable || [])
    .map(r => String(r).trim().toUpperCase()).filter(Boolean));
  // load rules
  const ruleFiles = readdirSync(RULES_DIR)
    .filter(f => f.endsWith('.mjs') && f.startsWith('mov-'))
    .sort();

  const rules = [];
  for (const rf of ruleFiles) {
    const mod = await import(pathToFileURL(join(RULES_DIR, rf)).href);
    validateRule(mod, rf);
    rules.push({ check: mod.check, meta: mod.meta, file: rf });
  }

  // load sources
  const sourceFiles = walkDir(resolve(sourcesDir), '.move');
  const allFindings = [];
  let suppressed = 0;

  for (const srcPath of sourceFiles) {
    const source = readFileSync(srcPath, 'utf8');
    const filename = relative(process.cwd(), srcPath);

    // skip test-only modules: #[test_only] must precede the first module declaration
    const moduleIdx = source.search(/\bmodule\b/);
    const prefix = stripBlockComments(moduleIdx >= 0 ? source.slice(0, moduleIdx) : '');
    if (/^\s*#\[test_only\]/m.test(prefix)) continue;

    const suppressions = parseSuppressions(source);

    for (const rule of rules) {
      let findings;
      try {
        findings = rule.check(source, filename);
      } catch (err) {
        const id = (rule.meta && rule.meta.id) || rule.file;
        throw new Error(`Error while running rule '${id}' on ${filename}: ${err.message}`, { cause: err });
      }
      for (const finding of findings) {
        if (isSuppressed(finding, suppressions, disabled)) {
          suppressed++;
          continue;
        }
        // Normalize once, here, so every downstream consumer (the reporter's
        // severity buckets, shouldFail's threshold comparison) can compare
        // against SEVERITY_ORDER/bySeverity's uppercase keys directly.
        // validateRule already requires meta.severity to be one of
        // VALID_SEVERITIES case-insensitively -- a rule declaring
        // `severity: 'high'` loaded clean but printed as INFO and could
        // never fail the gate, since neither consumer normalized case.
        allFindings.push({ ...finding, severity: String(finding.severity).toUpperCase() });
      }
    }
  }

  return { findings: allFindings, ruleCount: rules.length, suppressed };
}

/**
 * Print lint results to console.
 */
export function printLintResults(findings, ruleCount, suppressed = 0) {
  console.log(`\n=== Security Lint (${ruleCount} rules) ===\n`);

  if (findings.length === 0) {
    console.log('No findings.\n');
    if (suppressed > 0) console.log(`(${suppressed} finding(s) suppressed)\n`);
    return;
  }

  const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], INFO: [] };
  for (const f of findings) {
    (bySeverity[f.severity] || bySeverity.INFO).push(f);
  }

  for (const [sev, items] of Object.entries(bySeverity)) {
    for (const f of items) {
      const icon = sev === 'CRITICAL' || sev === 'HIGH' ? '🔴' : sev === 'MEDIUM' ? '🟡' : '🔵';
      console.log(`  ${icon} ${sev}  ${f.file}:${f.line}  [${f.rule}] ${f.message}`);
    }
  }

  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ');
  const note = suppressed > 0 ? `  (${suppressed} suppressed)` : '';
  console.log(`\n${findings.length} finding(s): ${summary}${note}`);
}

// Severity ordering, shared by the standalone CLI and the gate so the two can
// never disagree about what fails a build.
export const SEVERITY_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Do these findings warrant a non-zero exit at the given threshold? */
export function shouldFail(findings, threshold = 'high') {
  const t = String(threshold).toUpperCase();
  if (t === 'NONE') return false;
  const floor = SEVERITY_ORDER.indexOf(t);
  if (floor < 0) return findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  return findings.some(f => SEVERITY_ORDER.indexOf(f.severity) >= floor);
}

// standalone mode
if (process.argv[1] && process.argv[1].endsWith('lint.mjs')) {
  const dir = process.argv[2];
  if (!dir) {
    console.log('Usage: node scripts/lint.mjs <sources-dir>');
    process.exit(2);
  }
  const disIdx = process.argv.indexOf('--disable');
  const disable = disIdx >= 0 ? String(process.argv[disIdx + 1] || '').split(',') : [];
  const { findings, ruleCount, suppressed } = await runLint(dir, { disable });
  printLintResults(findings, ruleCount, suppressed);
  const failIdx = process.argv.indexOf('--fail-on');
  const threshold = failIdx >= 0 ? process.argv[failIdx + 1] : 'high';
  if (shouldFail(findings, threshold)) {
    process.exit(1);
  }
}
