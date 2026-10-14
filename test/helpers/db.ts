import type { MikroORM } from "@mikro-orm/postgresql";
import { type AppConfig, loadConfig } from "../../src/config";
import { createOrm, createOwnerOrm } from "../../src/infra/db/mikro-orm.config";

export interface TestDatabase {
  config: AppConfig;
  owner: ReturnType<typeof createOwnerOrm>;
  app: MikroORM;
  drop(): Promise<void>;
}

function baseConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD ?? "wagering_app_dev",
    DB_OWNER_PASSWORD: process.env.DB_OWNER_PASSWORD ?? "wagering_owner_dev",
  });
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const base = baseConfig();
  const name = `wagering_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

  const admin = createOwnerOrm(base);
  await admin.em.fork().execute(`create database "${name}"`);
  await admin.close();

  const config = { ...base, DB_NAME: name };
  const owner = createOwnerOrm(config);
  if (options.migrate !== false) await owner.migrator.up();
  const app = createOrm(config);

  return {
    config,
    owner,
    app,
    async drop() {
      await app.close();
      await owner.close();
      const cleanup = createOwnerOrm(base);
      await cleanup.em.fork().execute(`drop database "${name}" with (force)`);
      await cleanup.close();
    },
  };
}
