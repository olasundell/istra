// @vitest-environment node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");
const pluginRoot = resolve("plugins/istra");

describe("Claude Code plugin package", () => {
  it("declares a repository marketplace and cache-safe plugin runtime", async () => {
    const marketplace = JSON.parse(
      await readFile(join(repositoryRoot, ".claude-plugin/marketplace.json"), "utf8"),
    ) as Record<string, unknown>;
    const manifest = JSON.parse(
      await readFile(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const mcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers: { istra: { command: string; args: string[]; cwd: string } };
    };

    expect(marketplace).toMatchObject({
      name: "istra",
      description: "Installable Istra project-memory plugins for coding agents.",
      owner: { name: "Istra contributors" },
      plugins: [
        {
          name: "istra",
          source: "./plugins/istra",
          description: "Durable operational project memory for Claude Code.",
        },
      ],
    });
    expect(manifest).toMatchObject({
      name: "istra",
      displayName: "Istra",
      version: "0.1.0",
      description: "Durable operational project memory for open-ended work in Claude Code.",
      repository: "https://github.com/olasundell/istra",
      license: "MIT",
      defaultEnabled: true,
    });
    expect(mcp.mcpServers.istra).toMatchObject({
      command: "node",
      args: ["--eval", expect.stringContaining("CLAUDE_PLUGIN_ROOT")],
      cwd: ".",
    });
    expect(mcp.mcpServers.istra.args[1]).toContain("dist/mcp/stdio.mjs");
  });

  it("shares full skills while preserving host-specific write provenance", async () => {
    const projectMemory = await readFile(join(pluginRoot, "skills/istra-project-memory/SKILL.md"), "utf8");
    const errorReporting = await readFile(join(pluginRoot, "skills/istra-error-reporting/SKILL.md"), "utf8");

    expect(projectMemory).toContain('client: "codex-plugin:istra"');
    expect(projectMemory).toContain('client: "claude-plugin:istra"');
    expect(projectMemory).toContain("Call `resolve_project` first with the current checkout path.");
    expect(projectMemory).toContain("Confirm that `save_checkpoint` returned its snapshot identifier and digest.");
    expect(errorReporting).toMatch(/Codex, Claude Code or OpenCode plugins/);
    expect(errorReporting).toContain('client: "claude-plugin:istra"');
    expect(errorReporting).toContain("Never report a `report_error` failure");
  });
});
