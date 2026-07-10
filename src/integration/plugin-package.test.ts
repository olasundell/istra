// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../domain/contracts.js";
import { createRuntime } from "../infrastructure/runtime.js";

const pluginRoot = resolve("plugins/istra");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Codex plugin package", () => {
  it("declares a valid local MCP server and bundled project-memory skill", async () => {
    const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
    const mcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    const skill = await readFile(join(pluginRoot, "skills/istra-project-memory/SKILL.md"), "utf8");

    expect(manifest).toMatchObject({ name: "istra", mcpServers: "./.mcp.json", skills: "./skills/" });
    expect(mcp.mcpServers).toHaveProperty("istra");
    expect(skill).toContain("Call `get_project_pulse` before substantive work.");
    expect(skill).toContain("Do not bypass it through REST, direct SQLite access or a second persistence mechanism.");
  });

  it("runs the bundled stdio server and shares the application database", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "istra-plugin-test-"));
    temporaryDirectories.push(dataDir);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./dist/mcp/stdio.mjs"],
      cwd: pluginRoot,
      env: { ...environment, ISTRA_DATA_DIR: dataDir },
      stderr: "pipe",
    });
    const client = new Client({ name: "istra-plugin-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "get_project_pulse",
        "save_checkpoint",
        "search",
      ]));

      const created = await client.callTool({
        name: "create_project",
        arguments: { title: "Plugin-visible project", client: "plugin-package-test" },
      });
      const project = (created.structuredContent as { result: Project }).result;

      const application = await createRuntime({ dataDir });
      expect(application.service.getProject(project.id)?.project.title).toBe("Plugin-visible project");
      application.close();
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
