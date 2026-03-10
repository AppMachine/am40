/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import { execFile } from "node:child_process";
import http from "node:http";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  TerminalEvent,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  WsPush,
  WsResponse,
  ServerProviderStatus,
  KANBAN_WS_METHODS,
  KANBAN_WS_CHANNELS,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { GitScriptOps } from "./git/Services/GitScriptOps.ts";
import { SpotlightService } from "./spotlight/SpotlightService.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import { searchWorkspaceEntries } from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";
import { RegisteredRepoRepository } from "./persistence/Services/RegisteredRepoRepository.ts";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    | Scope.Scope
    | ServerRuntimeServices
    | ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | SqlClient.SqlClient
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

function messageFromCause(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  const message = squashed instanceof Error ? squashed.message.trim() : String(squashed).trim();
  return message.length > 0 ? message : Cause.pretty(cause);
}

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService
  | ProviderHealth;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | GitScriptOps
  | SpotlightService
  | RegisteredRepoRepository
  | TerminalManager
  | Keybindings
  | Open
  | AnalyticsService;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  | Scope.Scope
  | ServerRuntimeServices
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | SqlClient.SqlClient
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const gitScriptOps = yield* GitScriptOps;
  const spotlight = yield* SpotlightService;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const repoRepository = yield* RegisteredRepoRepository;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");

  function logOutgoingPush(push: WsPush, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      recipients,
      payload: push.data,
    });
  }

  const encodePush = Schema.encodeEffect(Schema.fromJsonString(WsPush));
  const broadcastPush = Effect.fnUntraced(function* (push: WsPush) {
    const message = yield* encodePush(push);
    let recipients = 0;
    for (const client of yield* Ref.get(clients)) {
      if (client.readyState === client.OPEN) {
        client.send(message);
        recipients += 1;
      }
    }
    logOutgoingPush(push, recipients);
  });

  const onTerminalEvent = Effect.fnUntraced(function* (event: TerminalEvent) {
    yield* broadcastPush({
      type: "push",
      channel: WS_CHANNELS.terminalEvent,
      data: event,
    });
  });

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
      const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return normalizedWorkspaceRoot;
    });

    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                stateDir: serverConfig.stateDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                stateDir: serverConfig.stateDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (streamExit._tag === "Failure") {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  // Push updated provider statuses to connected clients once background health checks finish.
  let providers: ReadonlyArray<ServerProviderStatus> = [];
  yield* providerHealth.getStatuses.pipe(
    Effect.flatMap((statuses) => {
      providers = statuses;
      return broadcastPush({
        type: "push",
        channel: WS_CHANNELS.serverConfigUpdated,
        data: {
          issues: [],
          providers: statuses,
        },
      });
    }),
    Effect.forkIn(subscriptionsScope),
  );

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    broadcastPush({
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
      data: event,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.changes, (event) =>
    broadcastPush({
      type: "push",
      channel: WS_CHANNELS.serverConfigUpdated,
      data: {
        issues: event.issues,
        providers,
      },
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);

  // Deduplicate projects with same normalized workspaceRoot.
  // Groups ALL projects (including soft-deleted) so we can recover
  // orphaned threads from previously-deleted duplicate projects.
  yield* Effect.gen(function* () {
    const dedupSnapshot = yield* projectionReadModelQuery.getSnapshot();
    const allProjects = dedupSnapshot.projects;
    const projectsByRoot = new Map<string, typeof allProjects>();
    for (const project of allProjects) {
      const normalized = path.resolve(project.workspaceRoot);
      const group = projectsByRoot.get(normalized) ?? [];
      group.push(project);
      projectsByRoot.set(normalized, group);
    }
    for (const [, projects] of projectsByRoot) {
      if (projects.length <= 1) continue;
      const sorted = projects.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
      const keeper = sorted.find((p) => p.deletedAt === null) ?? sorted[0];

      for (const other of sorted) {
        if (other.id === keeper.id) continue;
        yield* sql`
          UPDATE projection_threads
          SET project_id = ${keeper.id}
          WHERE project_id = ${other.id}
        `;
        if (other.deletedAt === null) {
          yield* orchestrationEngine.dispatch({
            type: "project.delete",
            commandId: CommandId.makeUnsafe(crypto.randomUUID()),
            projectId: other.id,
            deletedAt: new Date().toISOString(),
          });
        }
      }

      if (keeper.deletedAt !== null) {
        yield* sql`
          UPDATE projection_projects
          SET deleted_at = NULL, updated_at = ${new Date().toISOString()}
          WHERE project_id = ${keeper.id}
        `;
      }
    }
  }).pipe(Effect.ignore);

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const normalizedCwd = path.resolve(cwd);
      const existingProject = snapshot.projects.find(
        (project) =>
          path.resolve(project.workspaceRoot) === normalizedCwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path | SqlClient.SqlClient
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(onTerminalEvent(event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([
      closeAllClients,
      closeWebSocketServer.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close web socket server", { cause: error }),
        ),
      ),
    ]),
  );

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        return yield* orchestrationEngine.dispatch(normalizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem
          .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to prepare workspace path: ${String(cause)}`,
                }),
            ),
          );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitResolvePullRequest: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.resolvePullRequest(body);
      }

      case WS_METHODS.gitPreparePullRequestThread: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.preparePullRequestThread(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.gitSave: {
        const body = stripRequestTag(request.body);
        return yield* gitScriptOps.save(body.cwd, body.message);
      }

      case WS_METHODS.gitMergeFrom: {
        const body = stripRequestTag(request.body);
        return yield* gitScriptOps.mergeFrom(body.cwd, body.sourceBranch);
      }

      case WS_METHODS.gitMergeInto: {
        const body = stripRequestTag(request.body);
        return yield* gitScriptOps.mergeInto(body.cwd, body.targetBranch);
      }

      case WS_METHODS.gitOverwrite: {
        const body = stripRequestTag(request.body);
        return yield* gitScriptOps.overwrite(body.cwd, body.targetBranch);
      }

      case WS_METHODS.gitReset: {
        const body = stripRequestTag(request.body);
        return yield* gitScriptOps.reset(body.cwd, body.targetBranch);
      }

      case WS_METHODS.spotlightEnable: {
        const body = stripRequestTag(request.body);
        return yield* spotlight.enable({
          threadId: body.threadId,
          sourceDir: cwd,
          targetDir: cwd,
        });
      }

      case WS_METHODS.spotlightDisable: {
        const body = stripRequestTag(request.body);
        return yield* spotlight.disable(body.threadId);
      }

      case WS_METHODS.spotlightStatus: {
        const body = stripRequestTag(request.body);
        return yield* spotlight.status(body.threadId);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.repoList: {
        return yield* repoRepository.list;
      }

      case WS_METHODS.repoAdd: {
        const body = stripRequestTag(request.body);
        const repoPath = path.resolve(yield* expandHomePath(body.path.trim()));

        // Validate path is a git repo
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              execFile(
                "git",
                ["rev-parse", "--is-inside-work-tree"],
                { cwd: repoPath },
                (error) => {
                  if (error) reject(new Error(`Not a git repository: ${repoPath}`));
                  else resolve();
                },
              );
            }),
          catch: (cause) =>
            new RouteRequestError({
              message: cause instanceof Error ? cause.message : `Not a git repository: ${repoPath}`,
            }),
        });

        const repoName = body.name ?? (path.basename(repoPath) || "repo");
        const repo = {
          id: crypto.randomUUID(),
          name: repoName,
          path: repoPath,
          defaultBranch: "main",
          addedAt: new Date().toISOString(),
        };
        return yield* repoRepository.add(repo);
      }

      case WS_METHODS.repoRemove: {
        const body = stripRequestTag(request.body);
        return yield* repoRepository.remove(body.id);
      }

      case WS_METHODS.repoSetActive: {
        const body = stripRequestTag(request.body);
        const repo = yield* repoRepository.getById(body.id);
        if (!repo) {
          return yield* new RouteRequestError({
            message: `Repo not found: ${body.id}`,
          });
        }
        // Active repo is a client-side concern; acknowledge the request
        return { id: repo.id, path: repo.path };
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors,
        };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      // ── Kanban ──────────────────────────────────────────────────────
      case KANBAN_WS_METHODS.list: {
        const { projectId } = stripRequestTag(request.body);
        return yield* sql`
          SELECT id, projectId, title, description, status, position, threadId, createdAt, updatedAt
          FROM projection_kanban_tickets
          WHERE projectId = ${projectId}
          ORDER BY position ASC
        `;
      }

      case KANBAN_WS_METHODS.create: {
        const { projectId, title, status } = stripRequestTag(request.body);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const maxPosRows = yield* sql`
          SELECT COALESCE(MAX(position), 0) AS maxPos
          FROM projection_kanban_tickets
          WHERE projectId = ${projectId} AND status = ${status}
        `;
        const position = ((maxPosRows as ReadonlyArray<{ maxPos: number }>)[0]?.maxPos ?? 0) + 1;
        const ticket = {
          id,
          projectId,
          title,
          description: "",
          status,
          position,
          threadId: null,
          createdAt: now,
          updatedAt: now,
        };
        yield* sql`
          INSERT INTO projection_kanban_tickets (id, projectId, title, description, status, position, threadId, createdAt, updatedAt)
          VALUES (${ticket.id}, ${ticket.projectId}, ${ticket.title}, ${ticket.description}, ${ticket.status}, ${ticket.position}, ${ticket.threadId}, ${ticket.createdAt}, ${ticket.updatedAt})
        `;
        yield* broadcastPush({
          type: "push",
          channel: KANBAN_WS_CHANNELS.updated,
          data: { projectId },
        });
        return ticket;
      }

      case KANBAN_WS_METHODS.update: {
        const { id, ...fields } = stripRequestTag(request.body);
        const now = new Date().toISOString();
        if (fields.title !== undefined) {
          yield* sql`UPDATE projection_kanban_tickets SET title = ${fields.title}, updatedAt = ${now} WHERE id = ${id}`;
        }
        if (fields.description !== undefined) {
          yield* sql`UPDATE projection_kanban_tickets SET description = ${fields.description}, updatedAt = ${now} WHERE id = ${id}`;
        }
        if (fields.threadId !== undefined) {
          yield* sql`UPDATE projection_kanban_tickets SET threadId = ${fields.threadId}, updatedAt = ${now} WHERE id = ${id}`;
        }
        const updatedRows = yield* sql`
          SELECT id, projectId, title, description, status, position, threadId, createdAt, updatedAt
          FROM projection_kanban_tickets
          WHERE id = ${id}
        `;
        const updated = (updatedRows as ReadonlyArray<Record<string, unknown>>)[0];
        if (!updated) {
          return yield* new RouteRequestError({ message: `Kanban ticket not found: ${id}` });
        }
        yield* broadcastPush({
          type: "push",
          channel: KANBAN_WS_CHANNELS.updated,
          data: { projectId: updated.projectId },
        });
        return updated;
      }

      case KANBAN_WS_METHODS.move: {
        const { id, status, position } = stripRequestTag(request.body);
        const now = new Date().toISOString();
        yield* sql`
          UPDATE projection_kanban_tickets
          SET status = ${status}, position = ${position}, updatedAt = ${now}
          WHERE id = ${id}
        `;
        const movedRows = yield* sql`
          SELECT id, projectId, title, description, status, position, threadId, createdAt, updatedAt
          FROM projection_kanban_tickets
          WHERE id = ${id}
        `;
        const moved = (movedRows as ReadonlyArray<Record<string, unknown>>)[0];
        if (!moved) {
          return yield* new RouteRequestError({ message: `Kanban ticket not found: ${id}` });
        }
        yield* broadcastPush({
          type: "push",
          channel: KANBAN_WS_CHANNELS.updated,
          data: { projectId: moved.projectId },
        });
        return moved;
      }

      case KANBAN_WS_METHODS.delete: {
        const { id } = stripRequestTag(request.body);
        const ticketRows = yield* sql`
          SELECT projectId FROM projection_kanban_tickets WHERE id = ${id}
        `;
        const ticketRow = (ticketRows as ReadonlyArray<{ projectId: string }>)[0];
        yield* sql`DELETE FROM projection_kanban_tickets WHERE id = ${id}`;
        if (ticketRow) {
          yield* broadcastPush({
            type: "push",
            channel: KANBAN_WS_CHANNELS.updated,
            data: { projectId: ticketRow.projectId },
          });
        }
        return {};
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
      ws.send(errorResponse);
      return;
    }

    const request = Schema.decodeExit(Schema.fromJsonString(WebSocketRequest))(messageText);
    if (request._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${messageFromCause(request.cause)}` },
      });
      ws.send(errorResponse);
      return;
    }

    const result = yield* Effect.exit(routeRequest(request.value));
    if (result._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: request.value.id,
        error: { message: messageFromCause(result.cause) },
      });
      ws.send(errorResponse);
      return;
    }

    const response = yield* encodeResponse({
      id: request.value.id,
      result: result.value,
    });

    ws.send(response);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    void runPromise(Ref.update(clients, (clients) => clients.add(ws)));

    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcome: WsPush = {
      type: "push",
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd,
        projectName,
        ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
        ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
      },
    };
    logOutgoingPush(welcome, 1);
    ws.send(JSON.stringify(welcome));

    ws.on("message", (raw) => {
      void runPromise(
        handleMessage(ws, raw).pipe(
          Effect.catch((error) => Effect.logError("Error handling message", error)),
        ),
      );
    });

    ws.on("close", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
