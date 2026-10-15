import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import { loadConfig } from "../../src/config";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({
    PORT: "0",
    APP_ROLES: "api",
    DB_APP_PASSWORD: "unused",
    DB_HOST: "127.0.0.1",
    DB_PORT: "1",
    AWS_ENDPOINT_URL: "http://127.0.0.1:1",
  });
  app = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

test("GET /health/live returns 200 even when dependencies are down", async () => {
  const response = await fetch(`${baseUrl}/health/live`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("GET /health/ready returns 503 and names the failed dependencies", async () => {
  const response = await fetch(`${baseUrl}/health/ready`);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    status: "unavailable",
    checks: { postgres: "down", sqs: "down" },
  });
});

test("unknown route returns 404", async () => {
  const response = await fetch(`${baseUrl}/nope`);
  expect(response.status).toBe(404);
});
