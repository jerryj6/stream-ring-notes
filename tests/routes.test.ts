import { createServer } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { operatorApp } from "../src/index.js";

const server = createServer(operatorApp);
const key = "Bearer test_api_key_for_offline_checks_only";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("local Stream operator listener", () => {
  it("serves health and protects read-only status", async () => {
    const client = request(server);
    expect((await client.get("/health")).status).toBe(200);
    expect((await client.get("/api/stream/status")).status).toBe(401);
    const status = await client.get("/api/stream/status").set("Authorization", key);
    expect(status.status).toBe(200);
    expect(status.body.latest).toBeNull();
  });

  it("exposes no composer or general-purpose write routes", async () => {
    const client = request(server);
    expect((await client.get("/")).status).toBe(404);
    for (const path of ["/api/note", "/api/schedule", "/api/webhook/set-note", "/stream/ig"]) {
      expect((await client.post(path).set("Authorization", key).send({ text: "ignored" })).status).toBe(404);
    }
  });
});
