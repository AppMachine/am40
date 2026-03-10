/**
 * SpotlightService - Effect service for managing file-watching spotlight sessions.
 *
 * Enables/disables per-thread file watchers that sync worktree changes
 * to a target directory, with checkpoint creation at enable time.
 *
 * @module SpotlightService
 */
import { Effect, Layer, ServiceMap } from "effect";

import { GitService } from "../git/Services/GitService.ts";
import { GitCommandError } from "../git/Errors.ts";
import { startSpotlighter, type SpotlighterHandle } from "./spotlighter.ts";

interface SpotlightEntry {
  threadId: string;
  handle: SpotlighterHandle;
  checkpointTag: string | null;
  lastSyncAt: string | null;
}

/**
 * SpotlightServiceShape - Service API for managing spotlight sessions.
 */
export interface SpotlightServiceShape {
  /**
   * Enable spotlight for a thread: create baseline checkpoint and start watcher.
   */
  readonly enable: (input: {
    threadId: string;
    sourceDir: string;
    targetDir: string;
  }) => Effect.Effect<void, GitCommandError>;

  /**
   * Disable spotlight for a thread: stop watcher.
   */
  readonly disable: (threadId: string) => Effect.Effect<void, never>;

  /**
   * Get spotlight status for a thread.
   */
  readonly status: (
    threadId: string,
  ) => Effect.Effect<{ active: boolean; lastSyncAt: string | null }, never>;
}

/**
 * SpotlightService - Service tag for spotlight session management.
 */
export class SpotlightService extends ServiceMap.Service<
  SpotlightService,
  SpotlightServiceShape
>()("t3/spotlight/SpotlightService") {}

const makeSpotlightService = Effect.gen(function* () {
  const git = yield* GitService;
  const activeSpotlights = new Map<string, SpotlightEntry>();

  const createCheckpointTag = (
    cwd: string,
    threadId: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    Effect.gen(function* () {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tag = `checkpoint/${threadId}/${timestamp}`;

      const shaResult = yield* git.execute({
        operation: "SpotlightService.createCheckpoint.revParse",
        cwd,
        args: ["rev-parse", "HEAD"],
        allowNonZeroExit: true,
      });
      if (shaResult.code !== 0) return null;

      const tagResult = yield* git.execute({
        operation: "SpotlightService.createCheckpoint.tag",
        cwd,
        args: ["tag", tag, shaResult.stdout.trim()],
        allowNonZeroExit: true,
      });
      return tagResult.code === 0 ? tag : null;
    });

  const enable: SpotlightServiceShape["enable"] = (input) =>
    Effect.gen(function* () {
      // Stop existing spotlight if already active
      const existing = activeSpotlights.get(input.threadId);
      if (existing) {
        existing.handle.stop();
        activeSpotlights.delete(input.threadId);
      }

      // Create baseline checkpoint (best-effort)
      const checkpointTag = yield* createCheckpointTag(input.sourceDir, input.threadId).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );

      // Start file watcher
      const entry: SpotlightEntry = {
        threadId: input.threadId,
        handle: null as unknown as SpotlighterHandle,
        checkpointTag,
        lastSyncAt: null,
      };

      const handle = startSpotlighter({
        sourceDir: input.sourceDir,
        targetDir: input.targetDir,
        onSync: () => {
          entry.lastSyncAt = new Date().toISOString();
        },
        onError: (error) => {
          console.warn(`[spotlight] sync error for thread ${input.threadId}:`, error);
        },
      });

      entry.handle = handle;
      activeSpotlights.set(input.threadId, entry);
    });

  const disable: SpotlightServiceShape["disable"] = (threadId) =>
    Effect.sync(() => {
      const existing = activeSpotlights.get(threadId);
      if (existing) {
        existing.handle.stop();
        activeSpotlights.delete(threadId);
      }
    });

  const status: SpotlightServiceShape["status"] = (threadId) =>
    Effect.sync(() => {
      const entry = activeSpotlights.get(threadId);
      return {
        active: entry !== undefined,
        lastSyncAt: entry?.lastSyncAt ?? null,
      };
    });

  return {
    enable,
    disable,
    status,
  } satisfies SpotlightServiceShape;
});

export const SpotlightServiceLive = Layer.effect(SpotlightService, makeSpotlightService);
