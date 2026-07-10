import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: "plugins/istra/dist",
    ssr: true,
    target: "node24",
    rollupOptions: {
      input: {
        server: resolve(__dirname, "src/adapters/opencode/plugin.ts"),
        "mcp/stdio": resolve(__dirname, "src/adapters/mcp/stdio.ts"),
      },
      output: {
        entryFileNames: "[name].mjs",
        format: "es",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
