import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const url = new URL(process.argv[2] || "http://127.0.0.1:8779/stream/ig");
const secret = process.env.STREAM_WEBHOOK_SECRET;
if (!secret?.startsWith("swh_")) throw new Error("Set STREAM_WEBHOOK_SECRET in .env first.");
const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
  throw new Error("Provide a trusted HTTPS webhook URL or a loopback HTTP URL.");
}

const body = JSON.stringify({ text: "Webhook connectivity check", interaction_id: randomUUID() });
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac("sha256", secret).update(timestamp + ".").update(body).digest("hex");
const start = performance.now();
const response = await fetch(url, {
  method: "POST",
  redirect: "manual",
  signal: AbortSignal.timeout(5000),
  headers: { "Content-Type": "application/json", "X-Stream-Signature": `t=${timestamp},v1=${signature}` },
  body,
});
console.log(`HTTP ${response.status} in ${Math.round(performance.now() - start)} ms`);
if (response.status !== 204) process.exitCode = 1;
