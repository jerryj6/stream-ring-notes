import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";

async function login() {
  process.umask(0o077);
  await fs.mkdir(config.igProfileDir, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(config.igProfileDir, {
    headless: false,
    chromiumSandbox: true,
    channel: config.igChromeChannel || undefined,
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://www.instagram.com/direct/inbox/", { waitUntil: "domcontentloaded" });
    console.log("Sign in in the browser and open your Instagram inbox. The service must be stopped during login.");
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const cookies = await context.cookies("https://www.instagram.com/");
      if (page.url().startsWith("https://www.instagram.com/direct/") && cookies.some((cookie) => cookie.name === "sessionid" && cookie.value)) {
        if (process.argv.includes("--export")) {
          await fs.mkdir("data", { recursive: true, mode: 0o700 });
          const filename = path.resolve("data/storageState.json");
          await fs.writeFile(filename, JSON.stringify({ cookies }), { flag: "wx", mode: 0o600 });
          console.log("Created data/storageState.json. Treat this file as an Instagram credential.");
        }
        console.log("Login verified. You can now start the service.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Login timed out.");
  } finally {
    await context.close();
  }
}

login().catch(() => {
  console.error("Login could not finish. Check that Chromium is installed, the service is stopped, and any previous export has been moved out of data/.");
  process.exitCode = 1;
});
