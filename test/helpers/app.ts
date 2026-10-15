import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import type { ProviderIdentityPort } from "../../src/application/ports";
import { AppModule } from "../../src/app.module";
import type { AppConfig } from "../../src/config";
import { createApp } from "../../src/infra/http/setup";

export interface BootedApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

export async function bootApp(config: AppConfig, identity?: ProviderIdentityPort): Promise<BootedApp> {
  const unreachableSqs = { ...config, AWS_ENDPOINT_URL: "http://127.0.0.1:1", APP_ROLES: ["api" as const] };
  const app = await createApp(AppModule.forRoot(unreachableSqs, identity), { logger: false });
  await app.listen(0);
  return { app, baseUrl: await app.getUrl(), close: () => app.close() };
}
