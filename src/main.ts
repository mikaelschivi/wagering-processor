import "reflect-metadata";
import { AppModule } from "./app.module";
import { ConfigError, loadConfig } from "./config";
import { createApp } from "./infra/http/setup";
import { JsonLogger } from "./observability";

async function bootstrap() {
  const config = loadConfig(process.env);
  const app = await createApp(AppModule.forRoot(config), { logger: new JsonLogger() });
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
