# Releasing

A checklist, not a policy. Every step here is one already performed — the point
is that "what gets tagged and when" stops living only in the maintainer's head.

## Before tagging

1. `node eval/gate-selftest/run.mjs` is green.
   Without the `sui` CLI on PATH one case skips; that is expected, and a skip is
   not a pass — if you are changing Layer 2, install `sui` and re-run so the
   case actually executes.
2. `node eval/run.mjs doctor` is all clear — the CLI version matches the rev
   each scenario's `Move.toml` pins.
3. `package.json` `version` is the version you are about to tag.
4. `CHANGELOG.md` has a section for it. The **Unreleased** entries move unde
   the new heading.

## Tagging

5. Tag `vX.Y.Z` on `main` and cut the release.
6. Re-point the documented pins to the new tag:
   - `README.md` (the CI integration snippet)
   - `examples/workflows/pr-gate.yml`
   - `examples/workflows/nightly-mutation.yml`

   These three drift silently — nothing fails when they point at an old tag, so
   nothing catches it. Commit `7daae46` aligned them once; they went stale again
   at the next release.

## Afte

7. If the release contains a security fix, the advisory for it can be published
   now that a fixed version exists to point at.

## The failure this exists to prevent

`ceb4693` — a security fix — sat on `main` unreleased while the README pointed
consumers at a tag that predated it. Nothing was broken; there was simply no
step that said "re-point the pins", so nobody did.
