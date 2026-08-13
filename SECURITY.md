# Security Policy

## Reporting a vulnerability

**Please report privately, not as a public issue.**

Use GitHub's private vulnerability reporting on this repository:
**Security tab → Report a vulnerability**. It is enabled, and anyone with a
GitHub account can use it — you do not need write access here.

If you cannot use that form, open a public issue containing only the words
"security report, please contact me" and nothing else, and a maintainer will
arrange a private channel.

## Why private matters more than usual here

`move-test-gen` is installed by other repositories as a pull-request gate. A
defect that lets code slip past a rule does not only affect this project — it
affects every downstream repository relying on the gate, and those maintainers
cannot act on a report they have not seen yet.

The findings worth reporting privately are specifically:

- anything that makes a rule **not fire** on code it should catch
- anything that makes the gate **exit 0** when it should have failed
- anything that lets a pull-request author influence the gate's verdict from
  inside the source under review

Ordinary false positives, crashes and documentation problems are **not**
security issues — please open a normal issue for those. A rule that fires too
often is annoying; a rule that silently stops firing is the problem.

## Supported versions

Fixes land on `main` and go out in the next tag. Only the latest release is
supported — if you are pinned to an older tag, please upgrade before
reporting.

## What to expect

There is one maintainer and no service-level agreement. You can expect an
acknowledgement, a discussion in the advisory thread, and credit in the
published advisory unless you ask otherwise.
