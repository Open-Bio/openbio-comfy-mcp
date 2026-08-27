## Before changing code

* [ ] I can state the requested behavior change in one or two sentences.
* [ ] I found the closest existing implementation or convention.
* [ ] I know which files actually need to change.
* [ ] I distinguished required changes from merely desirable improvements.

## Scope

* [ ] Every changed file is necessary for the requested task.
* [ ] I did not fix unrelated problems I happened to notice.
* [ ] I did not perform unrelated cleanup, formatting, or renaming.
* [ ] I did not introduce a new abstraction when an existing pattern was sufficient.
* [ ] I did not generalize the solution for hypothetical future use cases.
* [ ] I did not add new dependencies unless required by the task.

## Defensive code

* [ ] Every new validation or guard handles a realistic state supported by project evidence.
* [ ] I did not add checks merely because an input could theoretically be null, missing, malformed, or unexpected.
* [ ] I preserved existing invariants instead of silently masking invariant violations.
* [ ] I did not add fallback behavior without a concrete requirement.

## Tests

* [ ] I used the narrowest existing tests that validate the change.
* [ ] A new test directly protects the behavior being changed or the bug being fixed.
* [ ] I did not expand the test matrix for hypothetical edge cases unrelated to the task.
* [ ] I did not rewrite tests merely to match my preferred implementation.

## Diff review

* [ ] The diff contains no changes that would be difficult to justify from the original request.
* [ ] If I reverted any individual changed hunk, I can explain what requirement would stop being satisfied.
* [ ] The solution follows existing repository conventions rather than generic “best practices.”
* [ ] A simpler patch would not solve the problem equally well.

## Final question

Before finishing, ask:

**“Did I solve the requested problem, or did I start improving the project?”**

If the answer is the latter, remove the unrelated improvements.

## Agent skills

### Issue tracker

Issues and specs use local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
