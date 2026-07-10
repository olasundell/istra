// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointSaveResult, Project } from "../domain/contracts.js";
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
    expect(skill).toContain("Call `resolve_project` first with the current checkout path.");
    expect(skill).toContain("Call `get_project_pulse_summary`");
    for (const tool of ["list_requirements_page", "list_operational_work_items_page", "list_external_blockers", "list_evidence_page"]) {
      expect(skill).toContain(`\`${tool}\``);
    }
    for (const tool of ["create_requirement", "update_requirement", "create_work_item", "update_work_item", "create_evidence"]) {
      expect(skill).toContain(`\`${tool}\``);
    }
    expect(skill).toContain("Record meaningful verification commands with `create_run`");
    expect(skill.toLocaleLowerCase()).toContain("link evidence to the exact acceptance criteria and work items");
    expect(skill).toContain("Never create evidence overrides.");
    expect(skill).toContain("Confirm that `save_checkpoint` returned its snapshot identifier and digest.");
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

      const saved = await client.callTool({
        name: "save_checkpoint",
        arguments: {
          projectId: project.id,
          expectedVersion: project.version,
          content: "Verified the bundled checkpoint response.",
          currentFocus: null,
          nextAction: null,
          blockers: [],
          idempotencyKey: "plugin-package-checkpoint",
          client: "plugin-package-test",
        },
      });
      const checkpoint = (saved.structuredContent as { result: CheckpointSaveResult }).result;
      expect(checkpoint).toMatchObject({
        checkpoint: { projectId: project.id, kind: "checkpoint" },
        snapshot: {
          id: expect.any(String),
          digest: expect.any(String),
          schemaVersion: 3,
          capturedAt: expect.any(String),
        },
      });
      expect(checkpoint.snapshot.id).not.toHaveLength(0);
      expect(checkpoint.snapshot.digest).toMatch(/^[a-f0-9]{64}$/);

      const application = await createRuntime({ dataDir });
      expect(application.service.getProject(project.id)?.project.title).toBe("Plugin-visible project");
      application.close();
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
