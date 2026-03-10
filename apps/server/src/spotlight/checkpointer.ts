/**
 * checkpointer - Create and restore lightweight git tag checkpoints.
 *
 * Uses `checkpoint/<threadId>/<timestamp>` tags for tracking state.
 *
 * @module checkpointer
 */
import { Effect } from "effect";

import { GitService } from "../git/Services/GitService.ts";
import { GitCommandError } from "../git/Errors.ts";

const CHECKPOINT_PREFIX = "checkpoint";

function makeCheckpointTag(threadId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${CHECKPOINT_PREFIX}/${threadId}/${timestamp}`;
}

export interface CheckpointInfo {
  tag: string;
  sha: string;
}

/**
 * Save a lightweight checkpoint tag at the current HEAD.
 */
export function saveCheckpoint(
  cwd: string,
  threadId: string,
): Effect.Effect<CheckpointInfo, GitCommandError, GitService> {
  return Effect.gen(function* () {
    const git = yield* GitService;
    const tag = makeCheckpointTag(threadId);

    const shaResult = yield* git.execute({
      operation: "checkpointer.saveCheckpoint.revParse",
      cwd,
      args: ["rev-parse", "HEAD"],
    });
    const sha = shaResult.stdout.trim();

    yield* git.execute({
      operation: "checkpointer.saveCheckpoint.tag",
      cwd,
      args: ["tag", tag, sha],
    });

    return { tag, sha };
  });
}

/**
 * Restore (hard reset) to a previously saved checkpoint tag.
 */
export function restoreCheckpoint(
  cwd: string,
  tag: string,
): Effect.Effect<void, GitCommandError, GitService> {
  return Effect.gen(function* () {
    const git = yield* GitService;
    yield* git.execute({
      operation: "checkpointer.restoreCheckpoint",
      cwd,
      args: ["reset", "--hard", tag],
    });
  });
}

/**
 * List all checkpoint tags for a given thread.
 */
export function listCheckpoints(
  cwd: string,
  threadId: string,
): Effect.Effect<CheckpointInfo[], GitCommandError, GitService> {
  return Effect.gen(function* () {
    const git = yield* GitService;
    const pattern = `${CHECKPOINT_PREFIX}/${threadId}/*`;

    const result = yield* git.execute({
      operation: "checkpointer.listCheckpoints",
      cwd,
      args: ["tag", "--list", pattern],
      allowNonZeroExit: true,
    });

    if (result.code !== 0 || result.stdout.trim().length === 0) {
      return [];
    }

    const tags = result.stdout
      .trim()
      .split("\n")
      .filter((t) => t.length > 0);

    const checkpoints: CheckpointInfo[] = [];
    for (const tag of tags) {
      const shaResult = yield* git.execute({
        operation: "checkpointer.listCheckpoints.revParse",
        cwd,
        args: ["rev-parse", tag],
        allowNonZeroExit: true,
      });
      if (shaResult.code === 0) {
        checkpoints.push({ tag, sha: shaResult.stdout.trim() });
      }
    }

    return checkpoints;
  });
}
