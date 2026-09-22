#!/usr/bin/env node
/**
 * check-pins.mjs — verifies every reference to this action, anywhere in
 * the tracked tree, is pinned to the RELEASE commit package.json's own
 * "version" field names.
 *
 * Why this exists: the example workflows drifted to the PRIOR release's
 * SHA after a version bump (talongate/move-test-gen#84 fixed it by hand
 * once; nothing re-checked it, so it came back the very next release).
 * A hard-coded file list rots the day a third example is added — the
 * reference set below is DERIVED from `git ls-files`, never enumerated
 * by hand.
 *
 * Usage:
 *   node scripts/check-pins.mjs
 *
 * Prints one line per reference found (file:line, OK or the specific
 * mismatch) and a summary. Exits 0 only when every reference checks out;
 * nonzero otherwise. Fails LOUD, never silently, when the release tag
 * itself does not resolve — that is a broken precondition for the whole
 * check, not a pass.
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

// The literal owner/repo this checker looks for is assembled from two
// halves rather than written as one string -- writing the whole
// "owner/repo@" address as a literal here would make THIS file's own
// source text match its own scan (this file is tracked too), which
// would misreport itself as a reference to classify.
const OWNER = 'talongate';
const REPO_NAME = 'move-test-gen';
const REF_PREFIX = `${OWNER}/${REPO_NAME}@`;
// The reference itself never contains whitespace (a YAML `uses:` value,
// or a bare address in prose) -- `\S+` runs to the next space/newline.
const REF_RE = new RegExp(`${REF_PREFIX.replace(/\//g, '\\/')}(\\S+)`, 'g');
const SHA_RE = /^[0-9a-f]{40}$/i;
const TAG_RE = /^v(\d+\.\d+\.\d+)$/;
// A trailing `# vX.Y.Z` comment on the SAME line as a SHA-pinned
// reference, anchored to end-of-line so it only matches the comment
// that actually follows this ref, never an unrelated `#` earlier on it.
const TRAILING_COMMENT_RE = /#\s*v(\d+\.\d+\.\d+)\s*$/;

/**
 * Read package.json's declared version and resolve it to the tag's
 * commit. Throws (never returns a partial/empty result) if the tag does
 * not exist -- a version bump with no matching tag means there is no
 * release SHA to check anything against, so the whole run is void, not
 * merely one finding short.
 */
function readReleaseInfo() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const version = pkg.version;
  if (!version) throw new Error('package.json has no "version" field');
  const tag = `v${version}`;
  let sha;
  try {
    // `^{commit}` peels an annotated tag to the commit it points at; a
    // lightweight tag already IS the commit, and peeling one is a no-op.
    sha = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(
      `tag ${tag} does not resolve to a commit -- package.json declares version ${version} but no such tag exists locally (checkout may need fetch-depth: 0). git rev-parse failed: ${err.message}`,
      { cause: err },
    );
  }
  return { version, tag, sha };
}

/** git's own binary heuristic: a NUL byte anywhere in the content. */
function isBinary(buf) {
  return buf.includes(0);
}

/**
 * Every tracked reference to the action, derived from `git ls-files`
 * rather than a hard-coded list of "the two example workflows" -- see
 * the file header for why a derived set is the entire point.
 */
function findReferences() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

  const refs = [];
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      // Tracked in the index but not present on disk (a submodule
      // gitlink, or a path deleted-but-not-yet-committed) -- not a real
      // file to scan, and not this checker's job to diagnose.
      continue;
    }
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      REF_RE.lastIndex = 0;
      let m;
      while ((m = REF_RE.exec(lines[i]))) {
        refs.push({ file, line: i + 1, ref: m[1], lineText: lines[i] });
      }
    }
  }
  return refs;
}

/**
 * Classify one found reference against the release info from
 * readReleaseInfo(). Three shapes, per the file header's own spec:
 *   - a 40-hex SHA, optionally with a trailing `# vX.Y.Z` comment
 *   - a `vX.Y.Z` tag
 *   - anything else -- a branch name, `@main`, a short SHA -- reported
 *     as unpinned/unrecognized, which counts as a failure: an
 *     unrecognized reference cannot be verified as the release, so it
 *     has not "checked out" per this file's own exit contract.
 */
function classifyRef(ref, release) {
  const token = ref.ref;

  if (SHA_RE.test(token)) {
    if (token.toLowerCase() !== release.sha.toLowerCase()) {
      return { ok: false, reason: `SHA ${token} does not match the release SHA ${release.sha} (${release.tag})` };
    }
    const commentMatch = ref.lineText.match(TRAILING_COMMENT_RE);
    if (commentMatch && commentMatch[1] !== release.version) {
      return { ok: false, reason: `SHA matches, but its trailing comment says v${commentMatch[1]} while package.json says v${release.version}` };
    }
    return { ok: true, reason: commentMatch ? `OK (SHA, # v${commentMatch[1]} agrees)` : 'OK (SHA, no trailing version comment)' };
  }

  const tagMatch = TAG_RE.exec(token);
  if (tagMatch) {
    if (tagMatch[1] !== release.version) {
      return { ok: false, reason: `tag v${tagMatch[1]} does not match package.json's version v${release.version}` };
    }
    return { ok: true, reason: `OK (tag v${tagMatch[1]})` };
  }

  return { ok: false, reason: `unpinned/unrecognized reference "${token}" -- neither a 40-hex SHA nor a vX.Y.Z tag` };
}

function main() {
  const release = readReleaseInfo();
  const refs = findReferences();

  console.log(`check-pins: package.json version ${release.version} -> ${release.tag} = ${release.sha}`);
  if (refs.length === 0) {
    console.log(`check-pins: no references to ${REF_PREFIX}<ref> found in the tracked tree`);
  }

  let failures = 0;
  for (const ref of refs) {
    const verdict = classifyRef(ref, release);
    console.log(`${ref.file}:${ref.line} ${verdict.ok ? 'OK' : 'MISMATCH'} -- ${verdict.reason}`);
    if (!verdict.ok) failures++;
  }

  console.log(`check-pins: ${refs.length - failures}/${refs.length} references OK`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
