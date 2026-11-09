import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createStreamReceiver } from "../src/routes/stream.js";
import { NotesService } from "../src/services/notes-service.js";
import type { OwnNote } from "../src/bridge/types.js";

const secret = "swh_offline_test_only";
const command = '{"text": "Instagram note: 🍂 Focus time", "interaction_id": "one"}';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function setup(settings = { secret, enabled: true }, notes?: NotesService) {
  const setFromCapture = vi.fn();
  const clearFromCapture = vi.fn();
  const receiver = createStreamReceiver(notes ?? { setFromCapture, clearFromCapture, checkInbox: vi.fn() }, settings);
  const server = createServer(receiver.app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const client = request(server);
  function signed(body: string, { timestamp = Math.floor(Date.now() / 1000), signatureBody = body } = {}) {
    const signature = createHmac("sha256", secret).update(timestamp + ".").update(signatureBody).digest("hex");
    return client.post("/stream/ig").type("json")
      .set("Connection", "close").timeout({ response: 2000, deadline: 3000 })
      .set("X-Stream-Signature", `t=${timestamp},v1=${signature}`).send(body);
  }
  return { ...receiver, setFromCapture, clearFromCapture, signed, client };
}

describe("signed Stream receiver", () => {
  it("acks before posting completes and suppresses repeats", async () => {
    const receiver = await setup();
    let finish!: () => void;
    receiver.setFromCapture.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    expect((await receiver.signed(command)).status).toBe(202);
    expect(receiver.status().latest?.outcome).toBe("pending");
    expect((await receiver.signed(command)).body.status).toBe("duplicate");
    expect((await receiver.signed(command.replace('"one"', '"two"'))).status).toBe(503);
    finish();
    await receiver.drain();
    expect(receiver.status().latest?.outcome).toBe("completed");
    expect(receiver.setFromCapture).toHaveBeenCalledExactlyOnceWith("🍂 Focus time");
  });

  it("drops unrelated interactions and matches case and clear punctuation", async () => {
    const receiver = await setup();
    for (const text of ["normal note", "Instagram notebook hello", "Instagram note", "Instagram note ———", "reminder: Instagram note hi"]) {
      expect((await receiver.signed(JSON.stringify({ text, interaction_id: "one" }))).status).toBe(204);
    }
    expect(receiver.status().latest).toBeNull();
    expect((await receiver.signed('{"text":"INSTAGRAM NOTE — clear!", "interaction_id":"one"}')).status).toBe(202);
    await receiver.drain();
    expect(receiver.clearFromCapture).toHaveBeenCalledExactlyOnceWith();
    expect(receiver.setFromCapture).not.toHaveBeenCalled();
  });

  it("rejects stale, future, missing and modified signatures", async () => {
    const receiver = await setup();
    const now = Math.floor(Date.now() / 1000);
    expect((await receiver.signed(command, { timestamp: now - 310 })).status).toBe(401);
    expect((await receiver.signed(command, { timestamp: now + 310 })).status).toBe(401);
    expect((await receiver.signed(command, { signatureBody: JSON.stringify(JSON.parse(command)) })).status).toBe(401);
    expect((await receiver.client.post("/stream/ig").type("json").send(command)).status).toBe(401);
    expect(receiver.setFromCapture).not.toHaveBeenCalled();
  });

  it("fails closed without a secret or private API opt-in", async () => {
    const missing = await setup({ secret: "", enabled: true });
    const disabled = await setup({ secret, enabled: false });
    expect((await missing.signed(command)).status).toBe(503);
    expect((await disabled.signed(command)).status).toBe(503);
  });

  it("rejects oversized or malformed JSON and keeps the private API off the public listener", async () => {
    const receiver = await setup();
    expect((await receiver.signed("{" + " ".repeat(17000))).status).toBe(413);
    expect((await receiver.signed("{")).status).toBe(400);
    expect((await receiver.signed('{"text":"Instagram note hi"}')).status).toBe(400);
    expect((await receiver.client.get("/api/session")).status).toBe(404);
    expect(receiver.setFromCapture).not.toHaveBeenCalled();
  });

  it("retains a generic failure result and never retries a failed action", async () => {
    const receiver = await setup();
    receiver.setFromCapture.mockRejectedValue(new Error("sensitive upstream content"));
    expect((await receiver.signed(command)).status).toBe(202);
    await vi.waitFor(() => expect(receiver.status().latest?.outcome).toBe("failed"));
    expect((await receiver.signed(command)).body.status).toBe("duplicate");
    expect(JSON.stringify(receiver.status())).not.toContain("sensitive");
    expect(receiver.setFromCapture).toHaveBeenCalledTimes(1);
  });
});

describe("Stream capture posting", () => {
  it("posts, replaces, and clears a Note from signed webhook deliveries", async () => {
    let active: OwnNote | undefined;
    const bridge = {
      getOwnNotes: vi.fn(async () => active ? [active] : []),
      createRawNote: vi.fn(async (text: string, audience: number) => {
        if (active) throw new Error("The existing Note must be removed before creating another.");
        active = { id: "simulated-note", text, audience, hasMusic: false };
      }),
      deleteRawNote: vi.fn(async (id: string) => {
        if (id !== active?.id) throw new Error("Unexpected Note ID.");
        active = undefined;
      }),
    };
    const receiver = await setup(undefined, new NotesService(bridge));
    const deliveries = [
      { text: "Instagram note: at the library", id: "post", expected: "at the library" },
      { text: "Instagram note: back after lunch", id: "replace", expected: "back after lunch" },
      { text: "Instagram note clear", id: "clear", expected: undefined },
    ];
    for (const { text, id, expected } of deliveries) {
      expect((await receiver.signed(JSON.stringify({ text, interaction_id: id }))).status).toBe(202);
      await vi.waitFor(() => expect(receiver.status().latest?.outcome).toBe("completed"));
      expect(active?.text).toBe(expected);
    }
  });

  it("never creates after an inbox read or delete failure", async () => {
    const bridge = {
      getOwnNotes: vi.fn().mockRejectedValueOnce(new Error("inbox unavailable"))
        .mockResolvedValue([{ id: "old", text: "old", audience: 0, hasMusic: false }]),
      deleteRawNote: vi.fn().mockRejectedValue(new Error("delete failed")),
      createRawNote: vi.fn(),
    };
    const notes = new NotesService(bridge);
    await expect(notes.setFromCapture("new")).rejects.toThrow("inbox unavailable");
    await expect(notes.setFromCapture("new")).rejects.toThrow("delete failed");
    expect(bridge.createRawNote).not.toHaveBeenCalled();
  });

  it("clips on grapheme boundaries and skips a duplicate note", async () => {
    const text = "a".repeat(59);
    const bridge = {
      getOwnNotes: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: "same", text, audience: 0, hasMusic: false }]),
      createRawNote: vi.fn(),
      deleteRawNote: vi.fn(),
    };
    const notes = new NotesService(bridge);
    await notes.setFromCapture(text + "🍂");
    await notes.setFromCapture(text + "🍂");
    expect(bridge.createRawNote).toHaveBeenCalledExactlyOnceWith(text, 0);
    expect(bridge.deleteRawNote).not.toHaveBeenCalled();
  });

  it("clears only the signed-in account's identified note", async () => {
    const bridge = {
      getOwnNotes: vi.fn().mockResolvedValue([{ id: "owned", text: "old", audience: 0, hasMusic: false }]),
      createRawNote: vi.fn(),
      deleteRawNote: vi.fn(),
    };
    await new NotesService(bridge).clearFromCapture();
    expect(bridge.deleteRawNote).toHaveBeenCalledExactlyOnceWith("owned");
    expect(bridge.createRawNote).not.toHaveBeenCalled();
  });
});
