import {
  closeDbExec,
  runMigrations,
  withMigrationRuntime,
} from "@agent-native/core/db";
import { loadEnv } from "@agent-native/core/scripts";
import { runFrameworkReleaseMigrations } from "@agent-native/core/server";
import {
  APP_MIGRATIONS,
  APP_MIGRATIONS_TABLE,
} from "../server/db/migrations.js";

loadEnv();

async function main(): Promise<void> {
  await withMigrationRuntime(async () => {
    await runFrameworkReleaseMigrations(null);
    // App-owned tables (server/db/migrations.ts) are applied in the same release step.
    await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
  });
}

try {
  await main();
} finally {
  await closeDbExec();
}
