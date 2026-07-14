---
name: code-review
description: Review a diff for correctness bugs before committing.
---

# Code review

When asked to review changes:

1. Read the full diff (`git diff` or the range the user gives you).
2. Look for correctness bugs first: off-by-one errors, unhandled null/undefined,
   error paths that swallow failures, concurrency hazards.
3. Only then comment on style, and only when it obscures behavior.
4. Report findings ordered by severity, each with the file, line, and a
   concrete failure scenario.
