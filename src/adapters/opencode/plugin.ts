import { fileURLToPath } from "node:url";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";

const mcpRuntimePath = fileURLToPath(new URL("./mcp/stdio.mjs", import.meta.url));
const instructionPath = fileURLToPath(new URL("../instructions/opencode-project-memory.md", import.meta.url));

const server: Plugin = async () => ({
  config: async (config) => {
    config.mcp ??= {};
    config.mcp.istra ??= {
      type: "local",
      command: ["node", mcpRuntimePath],
      enabled: true,
      timeout: 120_000,
    };

    if (!config.instructions?.includes(instructionPath)) {
      config.instructions = [...(config.instructions ?? []), instructionPath];
    }
  },
});

export default { id: "istra", server } satisfies PluginModule;
