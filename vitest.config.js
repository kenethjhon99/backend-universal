import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: false,
    pool: "threads",
    setupFiles: ["tests/setup/global-setup.js"],
  },
});
