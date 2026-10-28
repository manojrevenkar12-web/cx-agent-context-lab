import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:8799" },
  webServer: {
    command: "npx vite build && cd ../.. && PORT=8799 npx tsx apps/api/src/main.ts",
    url: "http://127.0.0.1:8799/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
