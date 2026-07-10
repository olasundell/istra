import { fileURLToPath } from "node:url";
const mcpRuntimePath = fileURLToPath(new URL("./mcp/stdio.mjs", import.meta.url));
const instructionPath = fileURLToPath(new URL("../instructions/opencode-project-memory.md", import.meta.url));
const server = async () => ({
  config: async (config) => {
    config.mcp ??= {};
    config.mcp.istra ??= {
      type: "local",
      command: ["node", mcpRuntimePath],
      enabled: true,
      timeout: 12e4
    };
    if (!config.instructions?.includes(instructionPath)) {
      config.instructions = [...config.instructions ?? [], instructionPath];
    }
  }
});
const plugin = { id: "istra", server };
export {
  plugin as default
};
