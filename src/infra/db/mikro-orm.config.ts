import { Migrator } from "@mikro-orm/migrations";
import { MikroORM } from "@mikro-orm/postgresql";
import type { AppConfig } from "../../config";
import { Migration0001Wallets } from "./migrations/Migration0001Wallets";

export const MIGRATIONS = [{ name: "Migration0001Wallets", class: Migration0001Wallets }];

function connection(config: AppConfig, user: string, password: string, dbName: string) {
  return {
    host: config.DB_HOST,
    port: config.DB_PORT,
    dbName,
    user,
    password,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
  };
}

export function createOrm(config: AppConfig): MikroORM {
  return MikroORM.initSync(connection(config, config.DB_APP_USER, config.DB_APP_PASSWORD, config.DB_NAME));
}

export function createOwnerOrm(config: AppConfig, dbName: string = config.DB_NAME) {
  if (!config.DB_OWNER_PASSWORD) throw new Error("DB_OWNER_PASSWORD is required for migrations");
  return MikroORM.initSync({
    ...connection(config, config.DB_OWNER_USER, config.DB_OWNER_PASSWORD, dbName),
    extensions: [Migrator],
    migrations: { migrationsList: MIGRATIONS },
  });
}
