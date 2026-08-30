// @vitest-environment node

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pngDimensions = (image: Buffer) => {
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
};

describe("Istra brand assets", () => {
  it("keeps every packaged logo identical to the selected original mark", async () => {
    const canonical = await readFile(resolve("assets/brand/istra-mark.png"));
    const copies = await Promise.all([
      readFile(resolve("plugins/istra/assets/istra-mark.png")),
      readFile(resolve("plugins/istra/skills/istra-project-memory/assets/istra-mark.png")),
      readFile(resolve("plugins/istra/skills/istra-error-reporting/assets/istra-mark.png")),
    ]);

    expect(pngDimensions(canonical)).toEqual({ width: 1254, height: 1254 });
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      "a38d86203848129829110b77c08739871fe25bab76f5bb4c63d6b406f0a0803d",
    );
    for (const copy of copies) expect(copy).toEqual(canonical);
  });

  it("declares supported host icons and packages the shared asset", async () => {
    const codex = JSON.parse(
      await readFile(resolve("plugins/istra/.codex-plugin/plugin.json"), "utf8"),
    ) as { interface: Record<string, unknown> };
    const cursorMarketplace = JSON.parse(
      await readFile(resolve(".cursor-plugin/marketplace.json"), "utf8"),
    ) as { plugins: Array<Record<string, unknown>> };
    const cursor = JSON.parse(
      await readFile(resolve("plugins/istra/.cursor-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const packaged = JSON.parse(
      await readFile(resolve("plugins/istra/package.json"), "utf8"),
    ) as Record<string, unknown>;
    const projectMemoryMetadata = await readFile(
      resolve("plugins/istra/skills/istra-project-memory/agents/openai.yaml"),
      "utf8",
    );
    const errorReportingMetadata = await readFile(
      resolve("plugins/istra/skills/istra-error-reporting/agents/openai.yaml"),
      "utf8",
    );

    expect(codex.interface).toMatchObject({
      logo: "./assets/istra-mark.png",
      composerIcon: "./assets/istra-mark.png",
      brandColor: "#064DBF",
    });
    expect(cursorMarketplace.plugins[0]).toMatchObject({
      logo: "./plugins/istra/assets/istra-mark.png",
    });
    expect(cursor).toMatchObject({ logo: "assets/istra-mark.png" });
    expect(packaged).toMatchObject({
      homepage: "https://github.com/olasundell/istra#readme",
      repository: {
        type: "git",
        url: "git+https://github.com/olasundell/istra.git",
      },
      bugs: { url: "https://github.com/olasundell/istra/issues" },
      files: expect.arrayContaining(["assets"]),
    });
    for (const metadata of [projectMemoryMetadata, errorReportingMetadata]) {
      expect(metadata).toContain('icon_small: "./assets/istra-mark.png"');
      expect(metadata).toContain('icon_large: "./assets/istra-mark.png"');
      expect(metadata).toContain('brand_color: "#064DBF"');
    }
  });

  it("ships correctly sized browser and installable-app raster icons", async () => {
    const expected = new Map([
      ["public/favicon-32.png", 32],
      ["public/apple-touch-icon.png", 180],
      ["public/icon-192.png", 192],
      ["public/icon-512.png", 512],
    ]);

    for (const [path, size] of expected) {
      expect(pngDimensions(await readFile(resolve(path)))).toEqual({ width: size, height: size });
    }

    const ico = await readFile(resolve("public/favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
  });

  it("ships a GitHub-ready social preview and visible repository branding", async () => {
    const socialPreview = await readFile(resolve(".github/social-preview.png"));
    const readmes = await Promise.all([
      readFile(resolve("README.md"), "utf8"),
      readFile(resolve("plugins/istra/README.md"), "utf8"),
      readFile(resolve("hermes/README.md"), "utf8"),
    ]);

    expect(pngDimensions(socialPreview)).toEqual({ width: 1280, height: 640 });
    expect(socialPreview.byteLength).toBeLessThan(1_000_000);
    expect(readmes[0]).toContain('assets/brand/istra-mark.png');
    expect(readmes[1]).toContain('assets/istra-mark.png');
    expect(readmes[2]).toContain('../assets/brand/istra-mark.png');
  });

  it("wires the favicon set and visible product wordmark", async () => {
    const html = await readFile(resolve("index.html"), "utf8");
    const shell = await readFile(resolve("src/web/components/AppShell.tsx"), "utf8");
    const pluginBuildConfig = await readFile(resolve("vite.plugin.config.ts"), "utf8");

    expect(html).toContain('href="/favicon-32.png"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(html).toContain('href="/site.webmanifest"');
    expect(shell).toContain('src="/icon-192.png"');
    expect(pluginBuildConfig).toMatch(/publicDir:\s*false/);
  });
});
