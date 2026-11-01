import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["parity/**/*.test.ts"],
    // Replays share one database.
    fileParallelism: false,
    // The models' Prisma client outlives a file in the worker, and each file restores `process.env` after
    // setting DATABASE_URL; without a run-wide value the next file's model queries find none.
    env: process.env.PARITY_DATABASE_URL ? { DATABASE_URL: process.env.PARITY_DATABASE_URL } : {},
  },
});
