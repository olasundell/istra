import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: "plugins/istra/mcp",
    ssr: resolve(__dirname, "src/adapters/mcp/stdio.ts"),
    target: "node24",
    rollupOptions: {
      output: {
        entryFileNames: "stdio.mjs",
        format: "es",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
