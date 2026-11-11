import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const mcpRuntimePath = fileURLToPath(new URL("./mcp/stdio.mjs", import.meta.url));
const instructionPath = fileURLToPath(new URL("../instructions/opencode-project-memory.md", import.meta.url));
const mcpTimeout = 12e4;
const server = async () => ({
  config: async (config) => {
    config.mcp ??= {};
    config.mcp.istra ??= {
      type: "local",
      command: ["node", mcpRuntimePath],
      enabled: true,
      timeout: mcpTimeout
    };
    if (!config.instructions?.includes(instructionPath)) {
      config.instructions = [...config.instructions ?? [], instructionPath];
    }
  }
});
const v2McpConfig = {
  type: "local",
  command: ["node", mcpRuntimePath],
  codemode: false,
  timeout: { startup: mcpTimeout, catalog: mcpTimeout, execution: mcpTimeout }
};
const setup = async (context) => {
  const instructions = await readFile(instructionPath, "utf8");
  await context.mcp.transform((editor) => {
    if (editor.get("istra") === void 0) {
      editor.set("istra", v2McpConfig);
    }
  });
  await context.session.hook("context", ({ system }) => {
    if (!system.some((part) => part.type === "text" && part.text === instructions)) {
      system.push({ type: "text", text: instructions });
    }
  });
};
const plugin = { id: "istra", server, setup };
export {
  plugin as default
};
