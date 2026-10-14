import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import type { AppConfig } from "../../src/config";

export interface BootedApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

export async function bootApp(config: AppConfig): Promise<BootedApp> {
  const unreachableSqs = { ...config, AWS_ENDPOINT_URL: "http://127.0.0.1:1" };
  const app = await NestFactory.create(AppModule.forRoot(unreachableSqs), { logger: false });
  await app.listen(0);
  return { app, baseUrl: await app.getUrl(), close: () => app.close() };
}
