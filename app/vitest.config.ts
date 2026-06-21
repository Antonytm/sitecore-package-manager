import { defineConfig } from "vitest/config";

// Tests for the pure `core/` layer. Node environment (no jsdom) — core works on
// Uint8Array/strings only. Integration suites read the git-ignored sample packages
// under ../files and self-skip when those are absent (see each suite's header).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Reading the 69 MB files-statically sample can be slow; keep a generous ceiling.
    testTimeout: 30_000,
  },
});
