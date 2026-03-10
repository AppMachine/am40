import { Schema, Struct } from "effect";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

import {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsInput,
  KANBAN_WS_METHODS,
  KanbanListInput,
  KanbanCreateInput,
  KanbanUpdateInput,
  KanbanMoveInput,
  KanbanDeleteInput,
} from "./orchestration";
import {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitCreateWorktreeInput,
  GitInitInput,
  GitListBranchesInput,
  GitMergeFromInput,
  GitMergeIntoInput,
  GitOverwriteInput,
  GitPullInput,
  GitPullRequestRefInput,
  GitRemoveWorktreeInput,
  GitResetInput,
  GitRunStackedActionInput,
  GitSaveInput,
  GitStatusInput,
  SpotlightDisableInput,
  SpotlightEnableInput,
  SpotlightStatusInput,
} from "./git";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "./terminal";
import { KeybindingRule } from "./keybindings";
import { ProjectSearchEntriesInput, ProjectWriteFileInput } from "./project";
import { OpenInEditorInput } from "./editor";
import { RepoAddInput, RepoListInput, RepoRemoveInput, RepoSetActiveInput } from "./repo";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitStatus: "git.status",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",
  gitSave: "git.save",
  gitMergeFrom: "git.mergeFrom",
  gitMergeInto: "git.mergeInto",
  gitOverwrite: "git.overwrite",
  gitReset: "git.reset",

  // Spotlight methods
  spotlightEnable: "spotlight.enable",
  spotlightDisable: "spotlight.disable",
  spotlightStatus: "spotlight.status",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Repo methods
  repoList: "repo.list",
  repoAdd: "repo.add",
  repoRemove: "repo.remove",
  repoSetActive: "repo.setActive",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverUpsertKeybinding: "server.upsertKeybinding",
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  terminalEvent: "terminal.event",
  serverWelcome: "server.welcome",
  serverConfigUpdated: "server.configUpdated",
  spotlightSync: "spotlight.sync",
} as const;

// -- Tagged Union of all request body schemas ─────────────────────────

const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(
    Struct.assign({ _tag: Schema.tag(tag) }),
    // PreserveChecks is safe here. No existing schema should have checks depending on the tag
    { unsafePreserveChecks: true },
  );

const WebSocketRequestBody = Schema.Union([
  // Orchestration methods
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    Schema.Struct({ command: ClientOrchestrationCommand }),
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getSnapshot, OrchestrationGetSnapshotInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getTurnDiff, OrchestrationGetTurnDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getFullThreadDiff, OrchestrationGetFullThreadDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.replayEvents, OrchestrationReplayEventsInput),

  // Project Search
  tagRequestBody(WS_METHODS.projectsSearchEntries, ProjectSearchEntriesInput),
  tagRequestBody(WS_METHODS.projectsWriteFile, ProjectWriteFileInput),

  // Shell methods
  tagRequestBody(WS_METHODS.shellOpenInEditor, OpenInEditorInput),

  // Git methods
  tagRequestBody(WS_METHODS.gitPull, GitPullInput),
  tagRequestBody(WS_METHODS.gitStatus, GitStatusInput),
  tagRequestBody(WS_METHODS.gitRunStackedAction, GitRunStackedActionInput),
  tagRequestBody(WS_METHODS.gitListBranches, GitListBranchesInput),
  tagRequestBody(WS_METHODS.gitCreateWorktree, GitCreateWorktreeInput),
  tagRequestBody(WS_METHODS.gitRemoveWorktree, GitRemoveWorktreeInput),
  tagRequestBody(WS_METHODS.gitCreateBranch, GitCreateBranchInput),
  tagRequestBody(WS_METHODS.gitCheckout, GitCheckoutInput),
  tagRequestBody(WS_METHODS.gitInit, GitInitInput),
  tagRequestBody(WS_METHODS.gitResolvePullRequest, GitPullRequestRefInput),
  tagRequestBody(WS_METHODS.gitPreparePullRequestThread, GitPreparePullRequestThreadInput),
  tagRequestBody(WS_METHODS.gitSave, GitSaveInput),
  tagRequestBody(WS_METHODS.gitMergeFrom, GitMergeFromInput),
  tagRequestBody(WS_METHODS.gitMergeInto, GitMergeIntoInput),
  tagRequestBody(WS_METHODS.gitOverwrite, GitOverwriteInput),
  tagRequestBody(WS_METHODS.gitReset, GitResetInput),

  // Spotlight methods
  tagRequestBody(WS_METHODS.spotlightEnable, SpotlightEnableInput),
  tagRequestBody(WS_METHODS.spotlightDisable, SpotlightDisableInput),
  tagRequestBody(WS_METHODS.spotlightStatus, SpotlightStatusInput),

  // Terminal methods
  tagRequestBody(WS_METHODS.terminalOpen, TerminalOpenInput),
  tagRequestBody(WS_METHODS.terminalWrite, TerminalWriteInput),
  tagRequestBody(WS_METHODS.terminalResize, TerminalResizeInput),
  tagRequestBody(WS_METHODS.terminalClear, TerminalClearInput),
  tagRequestBody(WS_METHODS.terminalRestart, TerminalRestartInput),
  tagRequestBody(WS_METHODS.terminalClose, TerminalCloseInput),

  // Repo methods
  tagRequestBody(WS_METHODS.repoList, RepoListInput),
  tagRequestBody(WS_METHODS.repoAdd, RepoAddInput),
  tagRequestBody(WS_METHODS.repoRemove, RepoRemoveInput),
  tagRequestBody(WS_METHODS.repoSetActive, RepoSetActiveInput),

  // Server meta
  tagRequestBody(WS_METHODS.serverGetConfig, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverUpsertKeybinding, KeybindingRule),

  // Kanban methods
  tagRequestBody(KANBAN_WS_METHODS.list, KanbanListInput),
  tagRequestBody(KANBAN_WS_METHODS.create, KanbanCreateInput),
  tagRequestBody(KANBAN_WS_METHODS.update, KanbanUpdateInput),
  tagRequestBody(KANBAN_WS_METHODS.move, KanbanMoveInput),
  tagRequestBody(KANBAN_WS_METHODS.delete, KanbanDeleteInput),
]);

export const WebSocketRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: WebSocketRequestBody,
});
export type WebSocketRequest = typeof WebSocketRequest.Type;

export const WebSocketResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type WebSocketResponse = typeof WebSocketResponse.Type;

export const WsPush = Schema.Struct({
  type: Schema.Literal("push"),
  channel: TrimmedNonEmptyString,
  data: Schema.Unknown,
});
export type WsPush = typeof WsPush.Type;

// ── Union of all server → client messages ─────────────────────────────

export const WsResponse = Schema.Union([WebSocketResponse, WsPush]);
export type WsResponse = typeof WsResponse.Type;

// ── Server welcome payload ───────────────────────────────────────────

export const WsWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type WsWelcomePayload = typeof WsWelcomePayload.Type;
