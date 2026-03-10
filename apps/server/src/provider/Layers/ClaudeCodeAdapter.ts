/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Wraps `ClaudeCodeProcessManager` behind the `ClaudeCodeAdapter` service
 * contract and maps manager failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module ClaudeCodeAdapterLive
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import { ClaudeCodeProcessManager } from "../../claudeCodeProcessManager.ts";

const PROVIDER = "claude-code" as const;

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: string,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown provider session") || normalized.includes("unknown session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: string, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

const makeClaudeCodeAdapter = () =>
  Effect.gen(function* () {
    const manager = yield* Effect.acquireRelease(
      Effect.sync(() => new ClaudeCodeProcessManager()),
      (mgr) =>
        Effect.sync(() => {
          try {
            mgr.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      return Effect.try({
        try: () =>
          manager.startSession({
            threadId: input.threadId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            runtimeMode: input.runtimeMode,
            ...(input.providerOptions?.claudeCode?.binaryPath !== undefined
              ? { binaryPath: input.providerOptions.claudeCode.binaryPath }
              : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Claude Code adapter session."),
            cause,
          }),
      });
    };

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.try({
        try: () => {
          const session = manager.listSessions().find((s) => s.threadId === input.threadId);
          return manager.sendTurn({
            threadId: input.threadId,
            ...(input.input !== undefined ? { input: input.input } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            runtimeMode: session?.runtimeMode ?? "full-access",
          });
        },
        catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
      }).pipe(
        Effect.map((result) => ({
          ...result,
          threadId: input.threadId,
        })),
      );

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.try({
        try: () => manager.interruptTurn(threadId, turnId),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      _threadId,
      _requestId,
      _decision,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: "Claude Code does not support interactive approval requests via this adapter.",
        }),
      );

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "Claude Code does not support interactive user input requests via this adapter.",
        }),
      );

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.succeed({
        threadId,
        turns: [],
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (threadId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail:
            "Claude Code does not support thread rollback. Session history is managed by the CLI.",
        }),
      );
    };

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        manager.stopSession(threadId);
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        manager.stopAll();
      });

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const services = yield* Effect.services<never>();
        const listener = (event: ProviderRuntimeEvent) =>
          Effect.gen(function* () {
            yield* Queue.offer(runtimeEventQueue, event);
          }).pipe(Effect.runPromiseWith(services));
        manager.on("event", listener);
        return listener;
      }),
      (listener) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            manager.off("event", listener);
          });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());
