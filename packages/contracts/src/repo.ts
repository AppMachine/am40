import { Schema } from "effect";
import { TrimmedNonEmptyString, IsoDateTime } from "./baseSchemas";

export const RegisteredRepo = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  defaultBranch: TrimmedNonEmptyString,
  addedAt: IsoDateTime,
});
export type RegisteredRepo = typeof RegisteredRepo.Type;

export const RepoListInput = Schema.Struct({});
export type RepoListInput = typeof RepoListInput.Type;

export const RepoAddInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
});
export type RepoAddInput = typeof RepoAddInput.Type;

export const RepoRemoveInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type RepoRemoveInput = typeof RepoRemoveInput.Type;

export const RepoSetActiveInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type RepoSetActiveInput = typeof RepoSetActiveInput.Type;
