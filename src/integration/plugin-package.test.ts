// @vitest-environment node

import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointSaveResult, ErrorReport, Project } from "../domain/contracts.js";
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
    const agentMetadata = await readFile(join(pluginRoot, "skills/istra-project-memory/agents/openai.yaml"), "utf8");
    const reportingSkill = await readFile(join(pluginRoot, "skills/istra-error-reporting/SKILL.md"), "utf8");
    const reportingMetadata = await readFile(join(pluginRoot, "skills/istra-error-reporting/agents/openai.yaml"), "utf8");

    expect(manifest).toMatchObject({
      name: "istra",
      description: "Durable operational project memory for open-ended work in Codex.",
      mcpServers: "./.mcp.json",
      skills: "./skills/",
      interface: {
        longDescription: expect.stringMatching(/report perceived Istra faults/i),
        defaultPrompt: expect.arrayContaining([
          expect.stringMatching(/requirements and work queue/i),
          expect.stringMatching(/verification run and link its evidence/i),
        ]),
      },
    });
    expect(mcp.mcpServers).toHaveProperty("istra");
    expect(agentMetadata).toMatch(/requirements, work and evidence/i);
    expect(reportingMetadata).toMatch(/allow_implicit_invocation: true/);
    expect(reportingSkill).toMatch(/report concrete or strongly suspected faults/i);
    expect(reportingSkill).toContain("Never report a `report_error` failure");
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

  it("runs the bundled stdio server outside the checkout and shares the application database", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "istra-plugin-test-"));
    const isolatedRoot = await mkdtemp(join(tmpdir(), "istra-plugin-package-"));
    temporaryDirectories.push(dataDir, isolatedRoot);
    await cp(pluginRoot, isolatedRoot, { recursive: true });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./dist/mcp/stdio.mjs"],
      cwd: isolatedRoot,
      env: { ...environment, ISTRA_STORAGE: "sqlite", ISTRA_DATABASE_URL: "", ISTRA_DATA_DIR: dataDir },
      stderr: "pipe",
    });
    const client = new Client({ name: "istra-plugin-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "create_evidence",
        "create_requirement",
        "create_run",
        "get_project_pulse_summary",
        "get_project_pulse",
        "get_storage_status",
        "list_evidence_page",
        "list_operational_work_items_page",
        "list_requirements_page",
        "report_error",
        "list_error_reports_page",
        "get_error_report",
        "update_error_report",
        "resolve_project",
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

      const reported = await client.callTool({
        name: "report_error",
        arguments: {
          kind: "design",
          component: "instructions",
          summary: "The error-reporting policy is misleading",
          observation: "A workflow instruction contradicts the tool contract.",
          idempotencyKey: "plugin-package-error-report",
          client: "plugin-package-test",
        },
      });
      const report = (reported.structuredContent as { result: ErrorReport }).result;
      expect(report).toMatchObject({ kind: "design", status: "open" });

      const application = await createRuntime({ dataDir });
      expect((await application.service.getProject(project.id))?.project.title).toBe("Plugin-visible project");
      expect((await application.service.getErrorReport(report.id))?.report).toMatchObject({ id: report.id, kind: "design" });
      await application.close();
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))("runs the isolated bundled MCP against PostgreSQL", async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "istra-plugin-postgres-"));
    const dataDir = await mkdtemp(join(tmpdir(), "istra-plugin-postgres-config-"));
    temporaryDirectories.push(isolatedRoot, dataDir);
    await cp(pluginRoot, isolatedRoot, { recursive: true });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./dist/mcp/stdio.mjs"],
      cwd: isolatedRoot,
      env: {
        ...environment,
        ISTRA_STORAGE: "postgresql",
        ISTRA_DATABASE_URL: process.env.TEST_DATABASE_URL!,
        ISTRA_DATA_DIR: dataDir,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "istra-plugin-postgres-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const response = await client.callTool({ name: "get_storage_status", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        result: {
          backend: "postgresql",
          target: expect.stringMatching(/^postgres(?:ql)?:\/\//),
          schemaVersion: expect.any(Number),
          ready: true,
          automaticBackups: false,
          importSupported: false,
        },
      });
      const target = new URL((response.structuredContent as { result: { target: string } }).result.target);
      expect({ username: target.username, password: target.password, search: target.search, hash: target.hash }).toEqual({
        username: "",
        password: "",
        search: "",
        hash: "",
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
