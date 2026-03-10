/**
 * GitScriptOps - Effect layer for git script workflow operations.
 *
 * Implements save, merge, overwrite, and reset operations with
 * backup tags for safety on destructive operations.
 *
 * @module GitScriptOpsLive
 */
import { Effect, Layer } from "effect";

import { GitCommandError } from "../Errors.ts";
import { GitService } from "../Services/GitService.ts";
import { GitScriptOps, type GitScriptOpsShape } from "../Services/GitScriptOps.ts";

const CONFLICT_MARKERS = ["<<<<<<<", "=======", ">>>>>>>"] as const;

function createBackupTag(branch: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sanitized = branch.replace(/\//g, "-");
  return `backup/${sanitized}/${timestamp}`;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: `git ${args.join(" ")}`,
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const makeGitScriptOps = Effect.gen(function* () {
  const git = yield* GitService;

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError> =>
    git
      .execute({
        operation,
        cwd,
        args,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.flatMap((result) => {
          if (allowNonZeroExit || result.code === 0) {
            return Effect.succeed(result);
          }
          const stderr = result.stderr.trim();
          return Effect.fail(
            createGitCommandError(
              operation,
              cwd,
              args,
              stderr.length > 0 ? stderr : `git ${args.join(" ")} failed: code=${result.code}`,
            ),
          );
        }),
      );

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    runGit(operation, cwd, args, allowNonZeroExit).pipe(Effect.map((r) => r.stdout));

  const getCurrentBranch = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    runGitStdout("GitScriptOps.getCurrentBranch", cwd, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]).pipe(
      Effect.map((stdout) => {
        const branch = stdout.trim();
        return branch === "HEAD" || branch.length === 0 ? null : branch;
      }),
    );

  const getCurrentSha = (cwd: string): Effect.Effect<string, GitCommandError> =>
    runGitStdout("GitScriptOps.getCurrentSha", cwd, ["rev-parse", "HEAD"]).pipe(
      Effect.map((stdout) => stdout.trim()),
    );

  const createTag = (
    cwd: string,
    tagName: string,
  ): Effect.Effect<void, GitCommandError> =>
    runGit("GitScriptOps.createTag", cwd, ["tag", tagName]).pipe(Effect.asVoid);

  const hasStagedConflictMarkers = (
    cwd: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    Effect.gen(function* () {
      const result = yield* runGit(
        "GitScriptOps.hasStagedConflictMarkers",
        cwd,
        ["diff", "--cached", "--unified=0"],
        true,
      );
      const patch = result.stdout;
      return CONFLICT_MARKERS.some((marker) => patch.includes(marker));
    });

  const save: GitScriptOpsShape["save"] = (cwd, message) =>
    Effect.gen(function* () {
      // Stage all changes
      yield* runGit("GitScriptOps.save.addAll", cwd, ["add", "-A"]);

      // Check if there are staged changes
      const statusResult = yield* runGit(
        "GitScriptOps.save.status",
        cwd,
        ["status", "--porcelain"],
        true,
      );
      if (statusResult.stdout.trim().length === 0) {
        return { status: "skipped_no_changes" as const };
      }

      // Check for conflict markers
      const hasConflicts = yield* hasStagedConflictMarkers(cwd);
      if (hasConflicts) {
        return yield* Effect.fail(
          createGitCommandError(
            "GitScriptOps.save",
            cwd,
            ["add", "-A"],
            "Staged files contain conflict markers. Resolve conflicts before committing.",
          ),
        );
      }

      // Create backup tag before commit
      const branch = yield* getCurrentBranch(cwd);
      const backupTag = createBackupTag(branch ?? "detached");
      yield* createTag(cwd, backupTag).pipe(Effect.catch(() => Effect.void));

      // Commit
      const commitMessage = message?.trim() || "Save changes";
      yield* runGit("GitScriptOps.save.commit", cwd, ["commit", "-m", commitMessage]);

      const commitSha = yield* getCurrentSha(cwd);

      // Push (best-effort)
      let pushed = false;
      if (branch) {
        const pushResult = yield* runGit(
          "GitScriptOps.save.push",
          cwd,
          ["push"],
          true,
        );
        if (pushResult.code === 0) {
          pushed = true;
        } else {
          // Try push with set-upstream
          const pushUpstreamResult = yield* runGit(
            "GitScriptOps.save.pushUpstream",
            cwd,
            ["push", "-u", "origin", branch],
            true,
          );
          pushed = pushUpstreamResult.code === 0;
        }
      }

      return {
        status: "saved" as const,
        commitSha,
        backupTag,
        pushed,
      };
    });

  const mergeFrom: GitScriptOpsShape["mergeFrom"] = (cwd, sourceBranch) =>
    Effect.gen(function* () {
      const result = yield* runGit(
        "GitScriptOps.mergeFrom",
        cwd,
        ["merge", sourceBranch, "--no-edit"],
        true,
      );

      if (result.code === 0) {
        const commitSha = yield* getCurrentSha(cwd);
        // Check if HEAD actually moved (not already_up_to_date)
        if (result.stdout.includes("Already up to date")) {
          return { status: "already_up_to_date" as const };
        }
        return { status: "merged" as const, commitSha };
      }

      // Merge conflict - get list of conflicting files
      const conflictResult = yield* runGit(
        "GitScriptOps.mergeFrom.conflictFiles",
        cwd,
        ["diff", "--name-only", "--diff-filter=U"],
        true,
      );
      const conflictFiles = conflictResult.stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);

      // Abort the merge so we leave the worktree clean
      yield* runGit("GitScriptOps.mergeFrom.abort", cwd, ["merge", "--abort"], true);

      return {
        status: "conflict" as const,
        conflictFiles,
      };
    });

  const mergeInto: GitScriptOpsShape["mergeInto"] = (cwd, targetBranch) =>
    Effect.gen(function* () {
      const currentBranch = yield* getCurrentBranch(cwd);
      if (!currentBranch) {
        return yield* Effect.fail(
          createGitCommandError(
            "GitScriptOps.mergeInto",
            cwd,
            ["merge"],
            "Cannot merge from detached HEAD.",
          ),
        );
      }

      // Checkout target branch
      yield* runGit("GitScriptOps.mergeInto.checkout", cwd, ["checkout", targetBranch]);

      // Try fast-forward merge
      const mergeResult = yield* runGit(
        "GitScriptOps.mergeInto.merge",
        cwd,
        ["merge", "--ff-only", currentBranch],
        true,
      );

      // Checkout back to original branch
      yield* runGit("GitScriptOps.mergeInto.checkoutBack", cwd, ["checkout", currentBranch]);

      if (mergeResult.code === 0) {
        if (mergeResult.stdout.includes("Already up to date")) {
          return { status: "already_up_to_date" as const };
        }
        const commitSha = yield* runGitStdout(
          "GitScriptOps.mergeInto.revParse",
          cwd,
          ["rev-parse", targetBranch],
        ).pipe(Effect.map((s) => s.trim()));
        return { status: "merged" as const, commitSha };
      }

      return {
        status: "conflict" as const,
        conflictFiles: [],
      };
    });

  const overwrite: GitScriptOpsShape["overwrite"] = (cwd, targetBranch) =>
    Effect.gen(function* () {
      const currentBranch = yield* getCurrentBranch(cwd);
      if (!currentBranch) {
        return yield* Effect.fail(
          createGitCommandError(
            "GitScriptOps.overwrite",
            cwd,
            ["push", "--force"],
            "Cannot overwrite from detached HEAD.",
          ),
        );
      }

      // Create backup tag of target branch state
      const backupTag = createBackupTag(targetBranch);
      // Try to tag the target branch's current head
      const targetShaResult = yield* runGit(
        "GitScriptOps.overwrite.targetSha",
        cwd,
        ["rev-parse", `refs/heads/${targetBranch}`],
        true,
      );
      if (targetShaResult.code === 0) {
        yield* runGit(
          "GitScriptOps.overwrite.backupTag",
          cwd,
          ["tag", backupTag, targetShaResult.stdout.trim()],
          true,
        );
      } else {
        // Target branch may be remote-only, tag current HEAD as reference
        yield* createTag(cwd, backupTag).pipe(Effect.catch(() => Effect.void));
      }

      // Force push current branch to target
      yield* runGit("GitScriptOps.overwrite.push", cwd, [
        "push",
        "origin",
        `${currentBranch}:${targetBranch}`,
        "--force",
      ]);

      return {
        status: "overwritten" as const,
        backupTag,
      };
    });

  const reset: GitScriptOpsShape["reset"] = (cwd, targetBranch) =>
    Effect.gen(function* () {
      const currentBranch = yield* getCurrentBranch(cwd);

      // Create backup tag of current state
      const previousSha = yield* getCurrentSha(cwd);
      const backupTag = createBackupTag(currentBranch ?? "detached");
      yield* createTag(cwd, backupTag).pipe(Effect.catch(() => Effect.void));

      // Hard reset to target
      yield* runGit("GitScriptOps.reset", cwd, ["reset", "--hard", targetBranch]);

      return {
        status: "reset" as const,
        backupTag,
        previousSha,
      };
    });

  return {
    save,
    mergeFrom,
    mergeInto,
    overwrite,
    reset,
  } satisfies GitScriptOpsShape;
});

export const GitScriptOpsLive = Layer.effect(GitScriptOps, makeGitScriptOps);
