import express from "express";
import { createServer, type Server } from "node:http";
import { config, validateServerConfig } from "./config.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createStreamReceiver } from "./routes/stream.js";
import { NotesService } from "./services/notes-service.js";
import { InstagramBridge } from "./bridge/instagram-bridge.js";

export const operatorApp = express();
const receiver = createStreamReceiver(new NotesService());
operatorApp.disable("x-powered-by");
operatorApp.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
operatorApp.get("/health", (_req, res) => res.json({ status: "ok", service: "instagram-notes-client" }));

const api = express.Router();
api.use(authMiddleware);
api.get("/stream/status", (_req, res) => res.json(receiver.status()));
api.get("/stream/instagram", async (_req, res) => {
  await receiver.checkInstagram();
  res.json({ status: "ready" });
});
operatorApp.use("/api", api);
operatorApp.use(errorHandler);

if (config.nodeEnv !== "test") {
  validateServerConfig();
  process.umask(0o077);
  const servers = [
    createServer(operatorApp).listen(config.port, config.host),
    createServer({ requestTimeout: 4500, headersTimeout: 4000, connectionsCheckingInterval: 500, keepAliveTimeout: 2000 }, receiver.app)
      .listen(config.streamPort, config.streamHost),
  ];
  for (const server of servers) {
    server.on("error", () => {
      console.error("A server listener failed. Verify both configured addresses and ports.");
      process.exit(1);
    });
  }

  async function closeServer(server: Server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 30_000).unref();
    await Promise.all([receiver.drain(), ...servers.map(closeServer)]);
    try {
      await InstagramBridge.getInstance().close();
    } finally {
      clearTimeout(deadline);
    }
  }
  process.on("SIGTERM", () => void shutdown().catch(() => process.exit(1)));
  process.on("SIGINT", () => void shutdown().catch(() => process.exit(1)));
}
