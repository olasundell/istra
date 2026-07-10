import { rm } from "node:fs/promises";

export default async function globalTeardown() {
  const dataDir = process.env.ISTRA_E2E_DATA_DIR;
  if (dataDir) await rm(dataDir, { force: true, recursive: true });
}

