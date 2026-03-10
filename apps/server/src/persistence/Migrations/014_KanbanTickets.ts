import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_kanban_tickets (
      id TEXT PRIMARY KEY NOT NULL,
      projectId TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      position REAL NOT NULL DEFAULT 0,
      threadId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_tickets_project
    ON projection_kanban_tickets(projectId)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_tickets_status
    ON projection_kanban_tickets(projectId, status)
  `;
});
