// @vitest-environment node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const pluginRoot = resolve("plugins/istra");
const runtimePath = resolve(pluginRoot, "dist/mcp/stdio.mjs");
const instructionPath = resolve(pluginRoot, "instructions/opencode-project-memory.md");

describe("OpenCode plugin package", () => {
  it("declares an OpenCode server export and packages its runtime assets", async () => {
    const manifest = JSON.parse(await readFile(resolve(pluginRoot, "package.json"), "utf8")) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      name: "opencode-istra",
      type: "module",
      main: "./dist/server.mjs",
      exports: { "./server": "./dist/server.mjs" },
      engines: { node: ">=24.0.0", opencode: ">=1.17.15 <2" },
    });

    const npmCache = await mkdtemp(join(tmpdir(), "istra-opencode-npm-cache-"));
    let packagedFiles: string[] | undefined;

    try {
      const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--cache", npmCache], { cwd: pluginRoot });
      const [pack] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      packagedFiles = pack?.files.map(({ path }) => path);
    } finally {
      await rm(npmCache, { force: true, recursive: true });
    }

    expect(packagedFiles).toEqual(expect.arrayContaining([
      ".codex-plugin/plugin.json",
      ".mcp.json",
      "dist/server.mjs",
      "dist/mcp/stdio.mjs",
      "instructions/opencode-project-memory.md",
      "skills/istra-project-memory/SKILL.md",
    ]));
  });

  it("adds Istra only when the user has not already configured it", async () => {
    const entry = pathToFileURL(resolve(pluginRoot, "dist/server.mjs")).href;
    const module = await import(entry) as { default: { id: string; server: () => Promise<{ config?: (config: Record<string, unknown>) => Promise<void> }> } };
    const hooks = await module.default.server();
    const config: Record<string, unknown> = { instructions: ["existing.md"] };

    await hooks.config?.(config);
    await hooks.config?.(config);

    expect(module.default.id).toBe("istra");
    expect(config).toMatchObject({
      mcp: {
        istra: {
          type: "local",
          command: ["node", runtimePath],
          enabled: true,
          timeout: 120_000,
        },
      },
      instructions: ["existing.md", instructionPath],
    });

    const overridden: Record<string, unknown> = {
      mcp: { istra: { type: "remote", url: "https://example.test/mcp" } },
    };
    await hooks.config?.(overridden);

    expect(overridden).toMatchObject({
      mcp: { istra: { type: "remote", url: "https://example.test/mcp" } },
      instructions: [instructionPath],
    });
  });
});
