/**
 * GitScriptOps - Effect service contract for git script operations.
 *
 * Provides high-level git workflow operations: save (add/commit/push),
 * merge, overwrite, and reset with safety backup tags.
 *
 * @module GitScriptOps
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type {
  GitMergeResult,
  GitOverwriteResult,
  GitResetResult,
  GitSaveResult,
} from "@t3tools/contracts";

import type { GitCommandError } from "../Errors.ts";

/**
 * GitScriptOpsShape - Service API for git script workflow operations.
 */
export interface GitScriptOpsShape {
  /**
   * Stage all, commit, and push. Creates a backup tag before committing.
   */
  readonly save: (cwd: string, message?: string) => Effect.Effect<GitSaveResult, GitCommandError>;

  /**
   * Merge a source branch INTO the current branch.
   */
  readonly mergeFrom: (
    cwd: string,
    sourceBranch: string,
  ) => Effect.Effect<GitMergeResult, GitCommandError>;

  /**
   * Fast-forward merge current branch INTO a target branch.
   * Checks out target, merges current, then checks back.
   */
  readonly mergeInto: (
    cwd: string,
    targetBranch: string,
  ) => Effect.Effect<GitMergeResult, GitCommandError>;

  /**
   * Force push current branch to target (creates backup tag first).
   */
  readonly overwrite: (
    cwd: string,
    targetBranch: string,
  ) => Effect.Effect<GitOverwriteResult, GitCommandError>;

  /**
   * Hard reset current branch to target (creates backup tag first).
   */
  readonly reset: (
    cwd: string,
    targetBranch: string,
  ) => Effect.Effect<GitResetResult, GitCommandError>;
}

/**
 * GitScriptOps - Service tag for git script workflow operations.
 */
export class GitScriptOps extends ServiceMap.Service<GitScriptOps, GitScriptOpsShape>()(
  "t3/git/Services/GitScriptOps",
) {}
