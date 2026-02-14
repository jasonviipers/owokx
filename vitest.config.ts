import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const configDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(configDir, "src/.test/cloudflare-workers.mock.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/policy/**/*.ts", "src/schemas/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },
  },
});
