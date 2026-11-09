import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { config } from "../config.js";
import { ServiceError } from "../middleware/error-handler.js";
import type { NotesService } from "../services/notes-service.js";

const SIGNATURE_WINDOW_SECONDS = 300;
const MAX_ACCEPTED_IDS = 2048;
const PREFIX = /^instagram\s+note(?=[\s,:;\-—]|$)[\s,:;\-—]*/i;
const CLEAR = new Set(["clear", "delete", "remove", "off", "none"]);

export function verifyStreamSignature(body: Buffer, header: string, secret: string, now: number): boolean {
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => /^t=\d{1,12}$/.test(part))?.slice(2);
  const signature = parts.find((part) => /^v1=[a-f0-9]{64}$/.test(part))?.slice(3);
  if (!secret || parts.length !== 2 || !timestamp || !signature) return false;
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(timestamp + ".").update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function createStreamReceiver(
  notes: Pick<NotesService, "setFromCapture" | "clearFromCapture" | "checkInbox">,
  settings = { secret: config.streamSecret, enabled: config.automationEnabled },
) {
  const app = express();
  app.disable("x-powered-by");
  app.enable("strict routing");
  app.enable("case sensitive routing");
  const seen = new Map<string, number>();
  let pending: Promise<void> | null = null;
  let latest: { outcome: string; at: string } | null = null;
  let closed = false;
  let checking = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.post(
    "/stream/ig",
    (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (!settings.secret || closed) { res.status(503).end(); return; }
      next();
    },
    express.raw({ type: "application/json", inflate: false, limit: "16kb" }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body)) { res.status(415).end(); return; }
      const now = Math.floor(Date.now() / 1000);
      if (!verifyStreamSignature(req.body, req.get("X-Stream-Signature") ?? "", settings.secret, now)) {
        res.status(401).end();
        return;
      }

      let payload: { text?: unknown; interaction_id?: unknown } | null;
      try {
        payload = JSON.parse(decoder.decode(req.body));
      } catch {
        res.status(400).end();
        return;
      }
      if (typeof payload?.text !== "string") { res.status(400).end(); return; }
      const interaction = payload.text.trim();
      const prefix = PREFIX.exec(interaction);
      const text = prefix ? interaction.slice(prefix[0].length).trim() : "";
      if (!text) { res.status(204).end(); return; }

      const id = payload.interaction_id;
      if (typeof id !== "string" || !id.trim() || id.length > 256) { res.status(400).end(); return; }
      if (!settings.enabled || closed) { res.status(503).end(); return; }

      for (const [key, expires] of seen) {
        if (expires < now) seen.delete(key);
      }
      const digest = createHash("sha256").update(id).digest("hex");
      if (seen.has(digest)) { res.status(200).json({ status: "duplicate" }); return; }
      if (pending || checking || seen.size >= MAX_ACCEPTED_IDS) { res.status(503).end(); return; }
      // A signature accepted at the far end of the future clock tolerance remains valid for 600s.
      seen.set(digest, now + 2 * SIGNATURE_WINDOW_SECONDS);
      latest = { outcome: "pending", at: new Date().toISOString() };
      res.status(202).json({ status: "accepted" });

      pending = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        let outcome = "completed";
        try {
          if (CLEAR.has(text.toLowerCase().replace(/[.!?]+$/, ""))) {
            await notes.clearFromCapture();
          } else {
            await notes.setFromCapture(text);
          }
        } catch (err) {
          outcome = err instanceof ServiceError ? err.code : "failed";
        } finally {
          latest = { outcome, at: new Date().toISOString() };
          pending = null;
        }
      });
    },
  );

  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status === 413 || err.status === 415 ? err.status : 400).end();
  });

  return {
    app,
    status: () => ({ configured: Boolean(settings.secret), enabled: settings.enabled, latest }),
    async checkInstagram() {
      if (closed || pending || checking) throw new ServiceError(503, "busy", "Wait for the current check or capture to finish.");
      checking = true;
      try {
        await notes.checkInbox();
      } finally {
        checking = false;
      }
    },
    drain: () => { closed = true; return pending; },
  };
}
