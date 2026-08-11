// @vitest-environment node

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(".");
const hermesRoot = join(repositoryRoot, "hermes");
const packagedRuntime = join(repositoryRoot, "plugins/istra/dist/mcp/stdio.mjs");

describe("Hermes Agent plugin", () => {
  it("declares an updateable repository-root plugin and registers namespaced skills", async () => {
    const manifest = await readFile(join(repositoryRoot, "plugin.yaml"), "utf8");
    const registration = await readFile(join(repositoryRoot, "__init__.py"), "utf8");

    expect(manifest).toMatch(/^manifest_version: 1$/m);
    expect(manifest).toMatch(/^name: istra$/m);
    expect(manifest).toMatch(/^version: 0\.1\.1$/m);
    expect(manifest).toMatch(/^kind: standalone$/m);
    expect(registration).toContain('Path(__file__).parent / "hermes" / "skills"');
    expect(registration).toContain('"istra-project-memory"');
    expect(registration).toContain('"istra-error-reporting"');
    expect(registration).toContain("ctx.register_skill(name, skills_dir / name / \"SKILL.md\", description)");
  });

  it("loads the Python entrypoint and registers both skill files", async () => {
    const python = [
      "import importlib.util, json",
      "from pathlib import Path",
      "module_path = Path('__init__.py').resolve()",
      "spec = importlib.util.spec_from_file_location('istra_hermes_plugin', module_path)",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "class Context:",
      "    def __init__(self): self.skills = []",
      "    def register_skill(self, name, path, description):",
      "        self.skills.append({'name': name, 'path': str(Path(path).resolve()), 'description': description})",
      "context = Context()",
      "module.register(context)",
      "print(json.dumps(context.skills))",
    ].join("\n");
    const { stdout } = await execFileAsync("python3", ["-c", python], {
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const registrations = JSON.parse(stdout) as Array<{ name: string; path: string; description: string }>;

    expect(registrations).toEqual([
      {
        name: "istra-project-memory",
        path: join(hermesRoot, "skills/istra-project-memory/SKILL.md"),
        description: "Use Istra as durable operational project memory through its MCP tools.",
      },
      {
        name: "istra-error-reporting",
        path: join(hermesRoot, "skills/istra-error-reporting/SKILL.md"),
        description: "Report concrete or strongly suspected faults in Istra itself.",
      },
    ]);
  });

  it("uses Hermes MCP names and preserves host-specific write provenance", async () => {
    const projectMemory = await readFile(
      join(hermesRoot, "skills/istra-project-memory/SKILL.md"),
      "utf8",
    );
    const errorReporting = await readFile(
      join(hermesRoot, "skills/istra-error-reporting/SKILL.md"),
      "utf8",
    );

    expect(projectMemory).toContain('client: "hermes-plugin:istra"');
    expect(projectMemory).toContain("`mcp__istra__resolve_project`");
    expect(projectMemory).toContain("`mcp__istra__get_project_pulse_summary`");
    expect(projectMemory).toContain("`mcp__istra__create_run`");
    expect(projectMemory).toContain("`mcp__istra__save_checkpoint`");
    expect(projectMemory).toContain("`istra:istra-error-reporting`");
    expect(errorReporting).toContain("`mcp__istra__report_error`");
    expect(errorReporting).toContain('client: "hermes-plugin:istra"');
    expect(errorReporting).toContain("If the mistake is yours, say so");
  });

  it("documents the supported plugin-plus-MCP installation boundary", async () => {
    const guide = await readFile(join(hermesRoot, "README.md"), "utf8");

    await access(packagedRuntime);
    expect(guide).toContain("hermes plugins install olasundell/istra --enable");
    expect(guide).toContain("hermes mcp add istra --command node");
    expect(guide).toContain("plugins/istra/dist/mcp/stdio.mjs");
    expect(guide).toContain("hermes mcp test istra");
    expect(guide).toContain("Hermes installation lacks MCP support");
    expect(guide).toContain("install the `[mcp]` extra in its environment");
    expect(guide).toContain("hermes -s istra:istra-project-memory");
    expect(guide).toContain("`mcp__istra__resolve_project`");
    expect(guide).toMatch(/does not let a native plugin register an MCP server/i);
  });
});
