import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import { loadConfig } from "../../src/config";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule.forRoot(loadConfig({ PORT: "0" })), { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

test("GET /health/live returns 200", async () => {
  const response = await fetch(`${baseUrl}/health/live`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("unknown route returns 404", async () => {
  const response = await fetch(`${baseUrl}/nope`);
  expect(response.status).toBe(404);
});
