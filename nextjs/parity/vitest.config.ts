import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["parity/**/*.test.ts"],
    // Replays share one database.
    fileParallelism: false,
  },
});
