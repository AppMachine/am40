/**
 * RegisteredRepoRepository - Persistence layer for registered repos.
 *
 * Manages CRUD operations for the registered_repos table.
 *
 * @module RegisteredRepoRepository
 */
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const RegisteredRepoRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  defaultBranch: Schema.String,
  addedAt: Schema.String,
});
export type RegisteredRepoRow = typeof RegisteredRepoRow.Type;

export interface RegisteredRepoRepositoryShape {
  readonly list: Effect.Effect<readonly RegisteredRepoRow[], ProjectionRepositoryError>;
  readonly add: (
    repo: RegisteredRepoRow,
  ) => Effect.Effect<RegisteredRepoRow, ProjectionRepositoryError>;
  readonly remove: (id: string) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    id: string,
  ) => Effect.Effect<RegisteredRepoRow | null, ProjectionRepositoryError>;
}

export class RegisteredRepoRepository extends ServiceMap.Service<
  RegisteredRepoRepository,
  RegisteredRepoRepositoryShape
>("t3/persistence/RegisteredRepoRepository") {}

export const RegisteredRepoRepositoryLive = Layer.effect(
  RegisteredRepoRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      list: Effect.gen(function* () {
        const rows = yield* sql`SELECT id, name, path, defaultBranch, addedAt FROM registered_repos ORDER BY addedAt DESC`;
        return rows.map((row) => Schema.decodeUnknownSync(RegisteredRepoRow)(row));
      }),

      add: (repo: RegisteredRepoRow) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO registered_repos (id, name, path, defaultBranch, addedAt)
            VALUES (${repo.id}, ${repo.name}, ${repo.path}, ${repo.defaultBranch}, ${repo.addedAt})
          `;
          return repo;
        }),

      remove: (id: string) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM registered_repos WHERE id = ${id}`;
        }),

      getById: (id: string) =>
        Effect.gen(function* () {
          const rows = yield* sql`SELECT id, name, path, defaultBranch, addedAt FROM registered_repos WHERE id = ${id}`;
          if (rows.length === 0) return null;
          return Schema.decodeUnknownSync(RegisteredRepoRow)(rows[0]);
        }),
    };
  }),
);
