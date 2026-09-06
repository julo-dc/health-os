/** Applies the schema. Idempotent — safe to run against an existing database. */
import { migrate, sql } from "../src/lib/db";

async function main() {
  await migrate();
  console.log("Schema is up to date.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
