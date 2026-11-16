import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts"],
    // The Redis-backed tests flush the one scratch database JOBS_REDIS_URL names (and REDIS_HOST/SIDEKIQ_REDIS_HOST point
    // at), so files running side by side wipe each other's keys.
    fileParallelism: !process.env.JOBS_REDIS_URL,
  },
});
