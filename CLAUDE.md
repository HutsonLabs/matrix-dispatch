# matrix-dispatch

## Workspace rules (mandatory)

The root checkout (this directory) is read-only for the main agent:

- Stay in the project root for the entire session. Never `cd` elsewhere to work, and never run `git checkout`/`git switch` or otherwise change branches in this checkout — it stays on the default branch, clean.
- Never edit, create, or delete project files directly in the root checkout. All code changes go through subagents dispatched to isolated git worktrees (Agent tool with `isolation: "worktree"`) or to dedicated branches in their own worktree.
- The main agent orchestrates: plan, dispatch subagents, review their results, and merge completed branches back. Reading, searching, and running read-only commands in the root checkout is fine.
- No exceptions for "quick" or one-line changes — route every edit through a worktree subagent.
