import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests for the pure `core/` layer plus the `storage/`, `xmc/` and designer logic that
// sits on top of it. Node environment (no jsdom) — everything under test works on
// Uint8Array/strings and plain data, with browser APIs injected rather than assumed.
// Integration suites read the git-ignored sample packages and definitions under ../files
// and self-skip when those are absent (see each suite's header).
export default defineConfig({
  resolve: {
    // Mirrors the `@/*` -> `./*` path alias in tsconfig.json, so test files can import
    // app modules by the same specifier the app uses.
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Reading the 69 MB files-statically sample can be slow; keep a generous ceiling.
    testTimeout: 30_000,
  },
});
