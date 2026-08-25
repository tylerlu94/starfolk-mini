import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations",
);

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('sfkm-schema-migrations'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const appliedNames = new Set(applied.rows.map(({ name }) => name));
    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();

    for (const name of files) {
      if (appliedNames.has(name)) {
        continue;
      }
      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('sfkm-schema-migrations'))");
    client.release();
  }
}
