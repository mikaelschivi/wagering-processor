import type { NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { HTTP_BODY_LIMIT } from "../../globals";

export async function createApp(
  module: Parameters<typeof NestFactory.create>[0],
  options: NestApplicationOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(module, { ...options, bodyParser: false });
  app.useBodyParser("json", { limit: HTTP_BODY_LIMIT });
  return app;
}
