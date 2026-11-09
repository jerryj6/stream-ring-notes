import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(4317),
  host: z.string().default("127.0.0.1"),
  nodeEnv: z.enum(["development", "production", "test"]).default("production"),
  apiKey: z.string().trim().default(""),
  automationEnabled: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  streamSecret: z.string().regex(/^swh_\S+$/).or(z.literal("")).default(""),
  streamPort: z.coerce.number().int().min(1).max(65535).default(8779),
  streamHost: z.string().default("127.0.0.1"),
  igProfileDir: z.string().default("./data/ig-profile"),
  igHeadless: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  igChromiumSandbox: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  igChromeChannel: z.string().default(""),
  noteCharLimit: z.coerce.number().int().min(1).max(60).default(60),
  defaultAudience: z.coerce.number().refine((val) => [0, 1].includes(val)).default(0),
});

const rawConfig = {
  port: process.env.PORT,
  host: process.env.HOST,
  nodeEnv: process.env.NODE_ENV,
  apiKey: process.env.API_KEY,
  automationEnabled: process.env.ENABLE_PRIVATE_API,
  streamSecret: process.env.STREAM_WEBHOOK_SECRET,
  streamPort: process.env.STREAM_PORT,
  streamHost: process.env.STREAM_HOST,
  igProfileDir: process.env.IG_PROFILE_DIR,
  igHeadless: process.env.IG_HEADLESS,
  igChromeChannel: process.env.IG_CHROME_CHANNEL,
  igChromiumSandbox: process.env.IG_CHROMIUM_SANDBOX,
  noteCharLimit: process.env.NOTE_CHAR_LIMIT,
  defaultAudience: process.env.DEFAULT_AUDIENCE,
};

const result = configSchema.safeParse(rawConfig);
if (!result.success) {
  throw new Error("Invalid configuration: " + result.error.issues.map((issue) => issue.path.join(".")).join(", "));
}
const parsed = result.data;

export function validateServerConfig() {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(parsed.apiKey)) {
    throw new Error("Set API_KEY to a random value of at least 32 URL-safe characters. Run npm run setup.");
  }
  if (parsed.port === parsed.streamPort) {
    throw new Error("PORT and STREAM_PORT must be different.");
  }
}

export const config = {
  ...parsed,
  igProfileDir: path.resolve(parsed.igProfileDir),
};

export type Config = typeof config;
