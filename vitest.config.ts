import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      NODE_ENV: "test",
      ENABLE_PRIVATE_API: "true",
      API_KEY: "test_api_key_for_offline_checks_only",
    },
  },
});
