/**
 * Re-exports database schema setup as `runMigrations` for backward compatibility.
 * There are no migrations — just CREATE TABLE IF NOT EXISTS on startup.
 */
export { createAllTables as runMigrations } from "./DatabaseSchema.ts";
export { DatabaseSchemaLive as MigrationsLive } from "./DatabaseSchema.ts";
