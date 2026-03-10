import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS registered_repos (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      defaultBranch TEXT NOT NULL DEFAULT 'main',
      addedAt TEXT NOT NULL
    )
  `;
});
