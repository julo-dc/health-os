import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "./src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Analytics tests are pure maths; the date-parsing tests assert UTC
    // behaviour, so pin the timezone rather than inheriting the machine's.
    env: { TZ: "UTC" },
  },
});
