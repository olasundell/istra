import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";

const mcpRuntimePath = fileURLToPath(new URL("./mcp/stdio.mjs", import.meta.url));
const instructionPath = fileURLToPath(new URL("../instructions/opencode-project-memory.md", import.meta.url));
const mcpTimeout = 120_000;

const server: Plugin = async () => ({
  config: async (config) => {
    config.mcp ??= {};
    config.mcp.istra ??= {
      type: "local",
      command: ["node", mcpRuntimePath],
      enabled: true,
      timeout: mcpTimeout,
    };

    if (!config.instructions?.includes(instructionPath)) {
      config.instructions = [...(config.instructions ?? []), instructionPath];
    }
  },
});

const v2McpConfig = {
  type: "local",
  command: ["node", mcpRuntimePath],
  codemode: false,
  timeout: { startup: mcpTimeout, catalog: mcpTimeout, execution: mcpTimeout },
} as const;

interface SetupContext {
  mcp: {
    transform(callback: (editor: {
      get(name: string): unknown;
      set(name: string, config: typeof v2McpConfig): void;
    }) => void): Promise<unknown>;
  };
  session: {
    hook(name: "context", callback: (event: {
      system: Array<{ type: string; text?: string }>;
    }) => void): Promise<unknown>;
  };
}

const setup = async (context: SetupContext) => {
  const instructions = await readFile(instructionPath, "utf8");

  await context.mcp.transform((editor) => {
    if (editor.get("istra") === undefined) {
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
export default plugin satisfies PluginModule;
