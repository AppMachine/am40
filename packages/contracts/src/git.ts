import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

// Domain Types

export const GitStackedAction = Schema.Literals(["commit", "commit_push", "commit_push_pr"]);
export type GitStackedAction = typeof GitStackedAction.Type;
const GitCommitStepStatus = Schema.Literals(["created", "skipped_no_changes"]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const GitStatusPrState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);

export const GitBranch = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitBranch = typeof GitBranch.Type;

const GitWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

// RPC Inputs

export const GitStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitStatusInput = typeof GitStatusInput.Type;

export const GitPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitPullInput = typeof GitPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const GitListBranchesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitListBranchesInput = typeof GitListBranchesInput.Type;

export const GitCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
  newBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitCreateWorktreeInput = typeof GitCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const GitRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type GitRemoveWorktreeInput = typeof GitRemoveWorktreeInput.Type;

export const GitCreateBranchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCreateBranchInput = typeof GitCreateBranchInput.Type;

export const GitCheckoutInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCheckoutInput = typeof GitCheckoutInput.Type;

export const GitInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitInitInput = typeof GitInitInput.Type;

// RPC Results

const GitStatusPr = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitStatusPrState,
});

export const GitStatusResult = Schema.Struct({
  branch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyStringSchema,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  pr: Schema.NullOr(GitStatusPr),
});
export type GitStatusResult = typeof GitStatusResult.Type;

export const GitListBranchesResult = Schema.Struct({
  branches: Schema.Array(GitBranch),
  isRepo: Schema.Boolean,
});
export type GitListBranchesResult = typeof GitListBranchesResult.Type;

export const GitCreateWorktreeResult = Schema.Struct({
  worktree: GitWorktree,
});
export type GitCreateWorktreeResult = typeof GitCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const GitPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  branch: TrimmedNonEmptyStringSchema,
  upstreamBranch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPullResult = typeof GitPullResult.Type;

// ── Git Script Operation Inputs ───────────────────────────────────────

export const GitSaveInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  message: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
});
export type GitSaveInput = typeof GitSaveInput.Type;

export const GitMergeFromInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  sourceBranch: TrimmedNonEmptyStringSchema,
});
export type GitMergeFromInput = typeof GitMergeFromInput.Type;

export const GitMergeIntoInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  targetBranch: TrimmedNonEmptyStringSchema,
});
export type GitMergeIntoInput = typeof GitMergeIntoInput.Type;

export const GitOverwriteInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  targetBranch: TrimmedNonEmptyStringSchema,
});
export type GitOverwriteInput = typeof GitOverwriteInput.Type;

export const GitResetInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  targetBranch: TrimmedNonEmptyStringSchema,
});
export type GitResetInput = typeof GitResetInput.Type;

// ── Git Script Operation Results ──────────────────────────────────────

export const GitSaveResult = Schema.Struct({
  status: Schema.Literals(["saved", "skipped_no_changes"]),
  commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
  backupTag: Schema.optional(TrimmedNonEmptyStringSchema),
  pushed: Schema.optional(Schema.Boolean),
});
export type GitSaveResult = typeof GitSaveResult.Type;

export const GitMergeResult = Schema.Struct({
  status: Schema.Literals(["merged", "conflict", "already_up_to_date"]),
  conflictFiles: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitMergeResult = typeof GitMergeResult.Type;

export const GitOverwriteResult = Schema.Struct({
  status: Schema.Literals(["overwritten"]),
  backupTag: TrimmedNonEmptyStringSchema,
});
export type GitOverwriteResult = typeof GitOverwriteResult.Type;

export const GitResetResult = Schema.Struct({
  status: Schema.Literals(["reset"]),
  backupTag: TrimmedNonEmptyStringSchema,
  previousSha: TrimmedNonEmptyStringSchema,
});
export type GitResetResult = typeof GitResetResult.Type;

// ── Spotlight Types ───────────────────────────────────────────────────

export const SpotlightEnableInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type SpotlightEnableInput = typeof SpotlightEnableInput.Type;

export const SpotlightDisableInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type SpotlightDisableInput = typeof SpotlightDisableInput.Type;

export const SpotlightStatusInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type SpotlightStatusInput = typeof SpotlightStatusInput.Type;

export const SpotlightStatusResult = Schema.Struct({
  active: Schema.Boolean,
  lastSyncAt: Schema.NullOr(Schema.String),
});
export type SpotlightStatusResult = typeof SpotlightStatusResult.Type;
