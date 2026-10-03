import type { Database } from "bun:sqlite";

/** Whether `name` is a table of this database. */
export const tableExists = (database: Database, name: string): boolean =>
  database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;

/** Whether `table` has the column `column`. */
export const hasColumn = (database: Database, table: string, column: string): boolean =>
  database.query("SELECT 1 FROM pragma_table_info(?) WHERE name=?").get(table, column) != null;
