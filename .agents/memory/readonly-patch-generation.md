---
name: Read-only patch generation (main agent)
description: How to produce a git patch file when index-mutating git is blocked.
---
As main agent, index/HEAD-mutating git is blocked: no staging (even intent-to-add),
no removal, no commit, and you CANNOT delete `.git/index.lock` (the path is filtered, and a
blocked stage can leave a stale lock behind). Read-only `git --no-optional-locks diff` still
works even with a stale lock present.

To build/refresh a patch file for tracked changes:
`git --no-optional-locks diff <baseline-ref> -- <paths...>`
For NEW (untracked) files, append: `git --no-optional-locks diff --no-index /dev/null <file>`
(untracked files never appear in a normal `diff <ref> -- path`).
Verify the patch matches the working tree with `git --no-optional-locks apply --reverse --check <patch>`
(a clean exit means the patch faithfully represents current tree vs baseline). A `--check`
(forward) against the index can fail with "does not match index" when a stale lock/index drift
exists -- that's not a patch defect; trust the reverse-apply check.

Note: heredocs whose CONTENT contains git-mutating command strings can trip the destructive-git
filter even though the heredoc only writes a file. Use the write/edit tools for such content.
