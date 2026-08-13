// @vitest-environment node

import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");
const pluginRoot = resolve("plugins/istra");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Cursor plugin package", () => {
  it("declares a repository marketplace and cache-safe plugin runtime", async () => {
    const marketplace = JSON.parse(
      await readFile(join(repositoryRoot, ".cursor-plugin/marketplace.json"), "utf8"),
    ) as Record<string, unknown>;
    const manifest = JSON.parse(
      await readFile(join(pluginRoot, ".cursor-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const mcp = JSON.parse(await readFile(join(pluginRoot, "mcp.json"), "utf8")) as {
      mcpServers: { istra: { command: string; args: string[]; cwd: string } };
    };
    const packaged = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8")) as { files: string[] };

    expect(marketplace).toMatchObject({
      name: "istra",
      owner: { name: "Istra contributors" },
      metadata: { description: "Installable Istra project-memory plugins for coding agents." },
      plugins: [
        {
          name: "istra",
          source: "./plugins/istra",
          description: "Durable operational project memory for Cursor.",
        },
      ],
    });
    expect(manifest).toMatchObject({
      name: "istra",
      displayName: "Istra",
      version: "0.1.0",
      description: "Durable operational project memory for open-ended work in Cursor.",
      author: { name: "Istra contributors" },
      homepage: "https://github.com/olasundell/istra#readme",
      repository: "https://github.com/olasundell/istra",
      license: "MIT",
      keywords: [
        "project-memory",
        "checkpoints",
        "requirements",
        "evidence",
        "error-reporting",
        "local-first",
      ],
      category: "developer-tools",
      tags: ["project-memory", "continuity", "verification", "local-first"],
      commands: "./commands/",
      skills: "./skills/",
      rules: "./rules/",
      mcpServers: "./mcp.json",
    });
    expect(mcp.mcpServers.istra).toMatchObject({
      command: "node",
      args: ["${PLUGIN_ROOT}/dist/mcp/stdio.mjs"],
      cwd: "${PLUGIN_ROOT}",
    });
    expect(mcp.mcpServers.istra.args[0]).not.toMatch(/[/\\]Users[/\\]|[/\\]home[/\\]/);
    expect(packaged.files).toEqual(expect.arrayContaining([".cursor-plugin", "mcp.json", "rules", "commands"]));
    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    const pluginReadme = await readFile(join(pluginRoot, "README.md"), "utf8");
    for (const docs of [readme, pluginReadme]) {
      expect(docs).toContain("rsync -a");
      expect(docs).not.toMatch(/ln -s[^\n]*~\/\.cursor\/plugins\/local\/istra/);
    }
  });

  it("runs the copied Cursor MCP bundle outside the checkout", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "istra-cursor-data-"));
    const isolatedRoot = await mkdtemp(join(tmpdir(), "istra-cursor-plugin-"));
    const workspace = await mkdtemp(join(tmpdir(), "istra-cursor-workspace-"));
    temporaryDirectories.push(dataDir, isolatedRoot, workspace);
    await cp(pluginRoot, isolatedRoot, { recursive: true });

    const mcp = JSON.parse(await readFile(join(isolatedRoot, "mcp.json"), "utf8")) as {
      mcpServers: { istra: { command: string; args: string[]; cwd: string } };
    };
    const expandPluginRoot = (value: string) => value.replaceAll("${PLUGIN_ROOT}", isolatedRoot);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const transport = new StdioClientTransport({
      command: mcp.mcpServers.istra.command,
      args: mcp.mcpServers.istra.args.map(expandPluginRoot),
      cwd: expandPluginRoot(mcp.mcpServers.istra.cwd),
      env: {
        ...environment,
        ISTRA_STORAGE: "sqlite",
        ISTRA_DATABASE_URL: "",
        ISTRA_DATA_DIR: dataDir,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "istra-cursor-plugin-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "create_evidence",
        "create_run",
        "get_project_pulse_summary",
        "report_error",
        "resolve_project",
        "save_checkpoint",
      ]));
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("shares full skills while preserving Cursor write provenance", async () => {
    const projectMemory = await readFile(join(pluginRoot, "skills/istra-project-memory/SKILL.md"), "utf8");
    const errorReporting = await readFile(join(pluginRoot, "skills/istra-error-reporting/SKILL.md"), "utf8");
    const rule = await readFile(join(pluginRoot, "rules/istra-project-memory.mdc"), "utf8");
    const pulse = await readFile(join(pluginRoot, "commands/istra-pulse.md"), "utf8");
    const checkpoint = await readFile(join(pluginRoot, "commands/istra-checkpoint.md"), "utf8");
    const reportFault = await readFile(join(pluginRoot, "commands/istra-report-fault.md"), "utf8");

    expect(projectMemory).toContain('client: "cursor-plugin:istra"');
    expect(errorReporting).toMatch(/Codex, Claude Code, Cursor or OpenCode plugins/);
    expect(errorReporting).toContain('client: "cursor-plugin:istra"');
    expect(errorReporting).toContain("Never report a `report_error` failure");
    expect(rule).toMatch(/^---\n(?:.+\n)*alwaysApply: true\n(?:.+\n)*---/m);
    expect(rule).toContain('client: "cursor-plugin:istra"');
    expect(pulse).toMatch(/^---\nname: istra-pulse\ndescription: .+\n---/m);
    expect(pulse).toContain("`resolve_project`");
    expect(pulse).toContain("`get_project_pulse_summary`");
    expect(checkpoint).toMatch(/^---\nname: istra-checkpoint\ndescription: .+\n---/m);
    expect(checkpoint).toContain("`save_checkpoint`");
    expect(reportFault).toMatch(/^---\nname: istra-report-fault\ndescription: .+\n---/m);
    expect(reportFault).toContain("`report_error`");
  });
});
