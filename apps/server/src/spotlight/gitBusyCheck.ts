/**
 * gitBusyCheck - Detect whether a git operation is currently in progress.
 *
 * Checks for in-progress rebase, merge, cherry-pick, bisect, and
 * lock files that indicate git is currently busy.
 *
 * @module gitBusyCheck
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const GIT_BUSY_INDICATORS = [
  // In-progress operations
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "BISECT_LOG",
  "REVERT_HEAD",
  // Lock files
  "index.lock",
  "shallow.lock",
  "packed-refs.lock",
] as const;

/**
 * Check whether a git repository has an in-progress operation or active lock.
 *
 * @param cwd - The working directory (should contain a `.git` directory or be a worktree)
 * @returns `true` if git is busy
 */
export function isGitBusy(cwd: string): boolean {
  const gitDir = join(cwd, ".git");

  for (const indicator of GIT_BUSY_INDICATORS) {
    if (existsSync(join(gitDir, indicator))) {
      return true;
    }
  }

  return false;
}
