import { loadConfig } from "../src/config";
import { createOwnerOrm } from "../src/infra/db/mikro-orm.config";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("usage: bun scripts/migrate.ts <up|down>");
  process.exit(1);
}

const orm = createOwnerOrm(loadConfig(process.env));
const applied = direction === "up" ? await orm.migrator.up() : await orm.migrator.down({ to: 0 });
console.log(`${direction}: ${applied.map((migration) => migration.name).join(", ") || "nothing to do"}`);
await orm.close();
