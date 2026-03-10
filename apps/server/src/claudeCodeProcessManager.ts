/**
 * ClaudeCodeProcessManager - Per-turn process spawning for Claude Code CLI.
 *
 * Unlike Codex (persistent JSON-RPC server), Claude Code uses per-turn process
 * spawning. Each turn spawns `claude --print --output-format stream-json` with
 * the user prompt piped via stdin, then parses NDJSON output lines.
 *
 * @module ClaudeCodeProcessManager
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type RuntimeMode,
} from "@t3tools/contracts";

// ── Types ───────────────────────────────────────────────────────────

interface ClaudeCodeSessionContext {
  session: ProviderSession;
  sessionId: string;
  child: ChildProcessWithoutNullStreams | null;
  turnId: TurnId | null;
  stopping: boolean;
}

export interface ClaudeCodeSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly model?: string;
  readonly runtimeMode: RuntimeMode;
  readonly binaryPath?: string;
}

export interface ClaudeCodeStartSessionInput {
  readonly threadId: ThreadId;
  readonly cwd?: string;
  readonly model?: string;
  readonly runtimeMode: RuntimeMode;
  readonly binaryPath?: string;
}

interface ClaudeCodeStreamEvent {
  readonly type: string;
  readonly subtype?: string;
  readonly index?: number;
  // Raw Anthropic streaming events (content_block_start/delta/stop)
  readonly content_block?: {
    readonly type?: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly id?: string;
    readonly name?: string;
    readonly input?: Record<string, unknown>;
  };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly partial_json?: string;
  };
  // Claude CLI high-level "assistant" event
  readonly message?: {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly text?: string;
      readonly thinking?: string;
      readonly id?: string;
      readonly name?: string;
      readonly input?: Record<string, unknown>;
    }>;
  };
  // Claude CLI "result" fields
  readonly result?: string;
  readonly cost_usd?: number;
  readonly duration_ms?: number;
  readonly duration_api_ms?: number;
  readonly is_error?: boolean;
  readonly num_turns?: number;
  readonly session_id?: string;
}

const CLAUDE_CODE_DEFAULT_COMMAND = "claude";

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(randomUUID());
}

function makeTurnId(): TurnId {
  return TurnId.makeUnsafe(randomUUID());
}

function makeRuntimeItemId(): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(randomUUID());
}

// ── Process Manager ─────────────────────────────────────────────────

export class ClaudeCodeProcessManager extends EventEmitter {
  private readonly sessions = new Map<ThreadId, ClaudeCodeSessionContext>();

  startSession(input: ClaudeCodeStartSessionInput): ProviderSession {
    const existing = this.sessions.get(input.threadId);
    if (existing && !existing.stopping) {
      return existing.session;
    }

    const now = nowIso();
    const sessionId = randomUUID();
    const session: ProviderSession = {
      provider: "claude-code",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const context: ClaudeCodeSessionContext = {
      session,
      sessionId,
      child: null,
      turnId: null,
      stopping: false,
    };

    this.sessions.set(input.threadId, context);

    this.emitRuntimeEvent({
      eventId: makeEventId(),
      provider: "claude-code",
      threadId: input.threadId,
      createdAt: now,
      type: "session.started",
      payload: {
        message: "Claude Code session started",
      },
    });

    this.emitRuntimeEvent({
      eventId: makeEventId(),
      provider: "claude-code",
      threadId: input.threadId,
      createdAt: now,
      type: "session.state.changed",
      payload: {
        state: "ready",
      },
    });

    return session;
  }

  sendTurn(input: ClaudeCodeSendTurnInput): { turnId: TurnId; threadId: ThreadId } {
    const context = this.sessions.get(input.threadId);
    if (!context) {
      throw new Error(`Unknown provider session: ${input.threadId}`);
    }
    if (context.stopping) {
      throw new Error(`Session is closed: ${input.threadId}`);
    }
    if (context.child) {
      throw new Error(`Turn already in progress for session: ${input.threadId}`);
    }

    const turnId = makeTurnId();
    context.turnId = turnId;

    if (input.model) {
      context.session = {
        ...context.session,
        model: input.model,
        updatedAt: nowIso(),
      };
    }

    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: nowIso(),
    };

    const command = input.binaryPath ?? CLAUDE_CODE_DEFAULT_COMMAND;
    const args = this.buildCliArgs(input, context);

    const turnStartedPayload: { model?: string } = {};
    if (input.model) {
      turnStartedPayload.model = input.model;
    }

    this.emitRuntimeEvent({
      eventId: makeEventId(),
      provider: "claude-code",
      threadId: input.threadId,
      createdAt: nowIso(),
      turnId,
      type: "turn.started",
      payload: turnStartedPayload,
    });

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
    });

    context.child = child;

    if (input.input) {
      child.stdin.write(input.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const rl = readline.createInterface({ input: child.stdout });
    const activeContentBlocks = new Map<
      number,
      { type: string; id?: string; name?: string; itemId?: RuntimeItemId }
    >();

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let parsed: ClaudeCodeStreamEvent;
      try {
        parsed = JSON.parse(trimmed) as ClaudeCodeStreamEvent;
      } catch {
        return;
      }

      this.handleStreamEvent(parsed, context, input.threadId, turnId, activeContentBlocks);
    });

    let stderrBuffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", (error) => {
      this.handleProcessExit(context, input.threadId, turnId, 1, error.message);
    });

    child.on("close", (code) => {
      rl.close();
      if (context.child === child) {
        const exitCode = code ?? 0;
        if (exitCode !== 0 && context.turnId === turnId) {
          const errorDetail = stderrBuffer.trim() || `Process exited with code ${exitCode}`;
          this.handleProcessExit(context, input.threadId, turnId, exitCode, errorDetail);
        }
        context.child = null;
      }
    });

    return { turnId, threadId: input.threadId };
  }

  interruptTurn(threadId: ThreadId, _turnId?: TurnId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown provider session: ${threadId}`);
    }
    if (!context.child) {
      return;
    }
    context.child.kill("SIGINT");
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    if (context.child) {
      context.child.kill("SIGTERM");
      context.child = null;
    }

    context.session = {
      ...context.session,
      status: "closed",
      updatedAt: nowIso(),
    };

    this.emitRuntimeEvent({
      eventId: makeEventId(),
      provider: "claude-code",
      threadId,
      createdAt: nowIso(),
      type: "session.exited",
      payload: {
        reason: "Session stopped",
        exitKind: "graceful",
      },
    });

    this.sessions.delete(threadId);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return Array.from(this.sessions.values()).map((ctx) => ctx.session);
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const threadId of Array.from(this.sessions.keys())) {
      this.stopSession(threadId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  private buildCliArgs(
    input: ClaudeCodeSendTurnInput,
    context: ClaudeCodeSessionContext,
  ): string[] {
    const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"];

    args.push("--session-id", context.sessionId);

    if (input.model) {
      args.push("--model", input.model);
    }

    if (input.runtimeMode === "full-access") {
      args.push("--dangerously-skip-permissions");
    } else if (input.runtimeMode === "approval-required") {
      args.push("--permission-mode", "default");
    }

    return args;
  }

  private handleStreamEvent(
    event: ClaudeCodeStreamEvent,
    context: ClaudeCodeSessionContext,
    threadId: ThreadId,
    turnId: TurnId,
    activeContentBlocks: Map<
      number,
      { type: string; id?: string; name?: string; itemId?: RuntimeItemId }
    >,
  ): void {
    const base = {
      eventId: makeEventId(),
      provider: "claude-code" as const,
      threadId,
      createdAt: nowIso(),
      turnId,
    };

    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (!block) return;

        const index = event.index ?? 0;
        const itemId = makeRuntimeItemId();
        const blockEntry: { type: string; id?: string; name?: string; itemId: RuntimeItemId } = {
          type: block.type ?? "unknown",
          itemId,
        };
        if (block.id !== undefined) blockEntry.id = block.id;
        if (block.name !== undefined) blockEntry.name = block.name;
        activeContentBlocks.set(index, blockEntry);

        if (block.type === "tool_use") {
          this.emitRuntimeEvent({
            ...base,
            itemId,
            type: "item.started",
            payload: {
              itemType: this.mapToolNameToItemType(block.name),
              status: "inProgress",
              title: block.name ?? "Tool call",
              data: {
                toolId: block.id,
                toolName: block.name,
              },
            },
          });
        }
        break;
      }

      case "content_block_delta": {
        const delta = event.delta;
        if (!delta) return;
        const index = event.index ?? 0;

        if (delta.type === "text_delta" && delta.text) {
          this.emitRuntimeEvent({
            ...base,
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: delta.text,
              contentIndex: index,
            },
          });
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          this.emitRuntimeEvent({
            ...base,
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: delta.thinking,
              contentIndex: index,
            },
          });
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          const blockInfo = activeContentBlocks.get(index);
          if (blockInfo) {
            this.emitRuntimeEvent({
              ...base,
              ...(blockInfo.itemId ? { itemId: blockInfo.itemId } : {}),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: delta.partial_json,
                contentIndex: index,
              },
            });
          }
        }
        break;
      }

      case "content_block_stop": {
        const index = event.index ?? 0;
        const blockInfo = activeContentBlocks.get(index);
        if (blockInfo && blockInfo.type === "tool_use") {
          this.emitRuntimeEvent({
            ...base,
            ...(blockInfo.itemId ? { itemId: blockInfo.itemId } : {}),
            type: "item.completed",
            payload: {
              itemType: this.mapToolNameToItemType(blockInfo.name),
              status: "completed",
              title: blockInfo.name ?? "Tool call",
            },
          });
        }
        activeContentBlocks.delete(index);
        break;
      }

      case "assistant": {
        const contentBlocks = event.message?.content;
        if (!contentBlocks || contentBlocks.length === 0) break;

        for (const block of contentBlocks) {
          if (block.type === "text" && block.text) {
            this.emitRuntimeEvent({
              ...base,
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: block.text,
                contentIndex: 0,
              },
            });
          } else if (block.type === "thinking" && block.thinking) {
            this.emitRuntimeEvent({
              ...base,
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text",
                delta: block.thinking,
                contentIndex: 0,
              },
            });
          } else if (block.type === "tool_use" && block.name) {
            const itemId = makeRuntimeItemId();
            this.emitRuntimeEvent({
              ...base,
              itemId,
              type: "item.started",
              payload: {
                itemType: this.mapToolNameToItemType(block.name),
                status: "completed",
                title: block.name,
                data: {
                  toolId: block.id,
                  toolName: block.name,
                  input: block.input,
                },
              },
            });
            this.emitRuntimeEvent({
              ...base,
              itemId,
              type: "item.completed",
              payload: {
                itemType: this.mapToolNameToItemType(block.name),
                status: "completed",
                title: block.name,
              },
            });
          }
        }
        break;
      }

      case "result": {
        const isError = event.is_error === true;
        const state = isError ? "failed" : "completed";

        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
        context.turnId = null;

        this.emitRuntimeEvent({
          ...base,
          type: "turn.completed",
          payload: {
            state,
            ...(event.cost_usd !== undefined ? { totalCostUsd: event.cost_usd } : {}),
            ...(isError && event.subtype
              ? { errorMessage: `Claude Code error: ${event.subtype}` }
              : {}),
            ...(event.subtype ? { stopReason: event.subtype } : {}),
          },
        });

        this.emitRuntimeEvent({
          eventId: makeEventId(),
          provider: "claude-code",
          threadId,
          createdAt: nowIso(),
          type: "session.state.changed",
          payload: {
            state: "ready",
          },
        });
        break;
      }
    }
  }

  private handleProcessExit(
    context: ClaudeCodeSessionContext,
    threadId: ThreadId,
    turnId: TurnId,
    _exitCode: number,
    errorDetail: string,
  ): void {
    if (context.turnId !== turnId) {
      return;
    }

    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: nowIso(),
      lastError: errorDetail,
    };
    context.turnId = null;

    this.emitRuntimeEvent({
      eventId: makeEventId(),
      provider: "claude-code",
      threadId,
      createdAt: nowIso(),
      turnId,
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: errorDetail,
      },
    });

    this.emitRuntimeEvent({
      eventId: makeEventId(),
      provider: "claude-code",
      threadId,
      createdAt: nowIso(),
      type: "session.state.changed",
      payload: {
        state: "ready",
      },
    });
  }

  private mapToolNameToItemType(
    toolName: string | undefined,
  ): "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call" | "unknown" {
    if (!toolName) return "unknown";
    const lower = toolName.toLowerCase();
    if (lower === "bash" || lower === "execute" || lower.includes("command")) {
      return "command_execution";
    }
    if (lower === "edit" || lower === "write" || lower === "read" || lower.includes("file")) {
      return "file_change";
    }
    if (lower.startsWith("mcp_") || lower.startsWith("mcp__")) {
      return "mcp_tool_call";
    }
    return "dynamic_tool_call";
  }

  private emitRuntimeEvent(event: ProviderRuntimeEvent): void {
    this.emit("event", event);
  }
}
