import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-schema-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, getDbExec, closeDbExec } = await import("@agent-native/core/db");
const { is } = await import("drizzle-orm");
const { PgTable, getTableConfig } = await import("drizzle-orm/pg-core");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("./migrations.js");
const schema = await import("./schema.js");

afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("schema.ts matches migrations", () => {
  it("has the same columns in every table", async () => {
    await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
    const tables = Object.values(schema).filter((v) => is(v, PgTable)) as InstanceType<typeof PgTable>[];
    expect(tables.length).toBeGreaterThanOrEqual(8);

    for (const table of tables) {
      const cfg = getTableConfig(table);
      const res = await getDbExec().execute({
        sql: "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
        args: [cfg.name],
      });
      const actual = res.rows.map((r: any) => (Array.isArray(r) ? r[0] : r.column_name)).sort();
      const declared = cfg.columns.map((c) => c.name).sort();
      expect({ table: cfg.name, columns: declared }).toEqual({ table: cfg.name, columns: actual });
    }
  });
});
