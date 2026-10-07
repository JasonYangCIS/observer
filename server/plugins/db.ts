import { runMigrations } from "@agent-native/core/db";
import { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } from "../db/migrations.js";

export default runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE });
