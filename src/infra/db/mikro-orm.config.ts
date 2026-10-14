import { MikroORM } from "@mikro-orm/postgresql";
import type { AppConfig } from "../../config";

export function createOrm(config: AppConfig): MikroORM {
  return MikroORM.initSync({
    host: config.DB_HOST,
    port: config.DB_PORT,
    dbName: config.DB_NAME,
    user: config.DB_APP_USER,
    password: config.DB_APP_PASSWORD,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
  });
}
