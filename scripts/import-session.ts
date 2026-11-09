import { readFileSync } from "node:fs";
import { InstagramBridge } from "../src/bridge/instagram-bridge.js";

async function run() {
  process.umask(0o077);
  const filename = process.argv[2];
  if (!filename) throw new Error("Provide a session file path or - to read from stdin.");
  const state = JSON.parse(readFileSync(filename === "-" ? 0 : filename, "utf8"));
  const cookies = state.cookies.filter((cookie: { domain?: string }) => {
    const domain = cookie.domain?.replace(/^\./, "");
    return domain === "instagram.com" || domain?.endsWith(".instagram.com");
  });
  if (!cookies.some((cookie: { name: string; value: string }) => cookie.name === "sessionid" && cookie.value)) {
    throw new Error("No Instagram session cookie in file.");
  }
  const bridge = InstagramBridge.getInstance();
  try {
    await bridge.importStorageState(cookies);
    console.log("Session copied into the local profile. Restart the service and verify the login.");
  } finally {
    await bridge.close();
  }
}

run().catch(() => {
  console.error("Session import failed. Check the file, Chromium installation, and that the service is stopped.");
  process.exitCode = 1;
});
