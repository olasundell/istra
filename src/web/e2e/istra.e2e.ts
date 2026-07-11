import { expect, test } from "@playwright/test";

test("durable project memory journey", async ({ page }) => {
  const suffix = Date.now();
  const title = `Signal Garden ${suffix}`;
  const labelName = `field-test-${suffix}`;
  const updateMarker = `signal${suffix}`;
  const updateContent = `Adaptive filtering reduced false positives in high wind. ${updateMarker}`;
  const revisedUpdateContent = `Adaptive filtering reduced false positives in high wind and rain. ${updateMarker}`;
  await page.goto("/");

  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project title").fill(title);
  await page.getByLabel("Description").fill("A distributed garden-sensing system that adapts to changing light and weather.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const projectUrl = page.url();

  await page.getByLabel("Project state").selectOption("paused");
  await expect(page.getByLabel("Project state")).toHaveValue("paused");
  await page.getByLabel("Project state").selectOption("active");
  await expect(page.getByLabel("Project state")).toHaveValue("active");

  await page.getByRole("button", { name: "Record checkpoint" }).click();
  const checkpointDialog = page.getByRole("dialog", { name: "Record checkpoint" });
  await checkpointDialog.getByLabel("What changed?").fill("Deployed firmware v0.3.2 to the field mesh and reduced false positives.");
  await checkpointDialog.getByLabel("Current focus").fill("Adaptive antenna array firmware");
  await checkpointDialog.getByLabel("Next action").fill("Implement phase calibration routine");
  await checkpointDialog.getByLabel("Blockers").fill("Waiting on low-noise amplifiers");
  await checkpointDialog.getByRole("button", { name: "Save checkpoint" }).click();
  await expect(checkpointDialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Current pulse" }).getByText("Adaptive antenna array firmware", { exact: true })).toBeVisible();

  for (const phaseName of ["Field mesh", "Power study"]) {
    await page.getByRole("button", { name: "Add phase" }).click();
    await page.getByLabel("Name").fill(phaseName);
    await page.getByLabel("Status").selectOption("active");
    await page.getByRole("button", { name: "Save phase" }).click();
  }
  await expect(page.getByText("Field mesh", { exact: true })).toBeVisible();
  await expect(page.getByText("Power study", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add work item" }).click();
  const workItemDialog = page.getByRole("dialog");
  await workItemDialog.getByLabel("Title").fill("Resolve calibration drift");
  await workItemDialog.getByLabel("Type").selectOption("issue");
  await workItemDialog.getByLabel("Status").selectOption("in_progress");
  await workItemDialog.getByLabel("Priority").selectOption("high");
  await workItemDialog.getByRole("combobox", { name: "Phase" }).selectOption({ label: "Field mesh" });
  await workItemDialog.getByLabel("Create and assign a new label").fill(labelName);
  await workItemDialog.getByRole("button", { name: "Save work item" }).click();
  await expect(workItemDialog).toBeHidden();
  await expect(page.getByRole("cell", { name: `Resolve calibration drift ${labelName}`, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add update" }).click();
  const updateDialog = page.getByRole("dialog");
  await updateDialog.getByLabel("Update type").selectOption("progress");
  await updateDialog.getByLabel("What happened?").fill(updateContent);
  await updateDialog.getByRole("button", { name: "Add update" }).click();
  const progressEntry = page.locator(".journal-entry--progress");
  await expect(progressEntry).toContainText(updateContent);
  await progressEntry.getByRole("button", { name: "Revise update" }).click();
  await page.getByLabel("What happened?").fill(revisedUpdateContent);
  await page.getByRole("button", { name: "Save revision" }).click();
  await expect(progressEntry).toContainText(revisedUpdateContent);

  await page.getByRole("link", { name: "Search" }).click();
  await page.getByLabel("Search all project memory").fill(updateMarker);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(revisedUpdateContent, { exact: true })).toBeVisible();

  await page.goto(projectUrl);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page).toHaveURL(/\/archive$/);
  const archivedRow = page.locator(".archive-row").filter({ hasText: title });
  await expect(archivedRow).toBeVisible();
  await archivedRow.getByRole("button", { name: "Restore" }).click();
  await expect(archivedRow).toBeHidden();

  await page.getByRole("button", { name: "Data & backups" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /Export all data/ }).click();
  const download = await downloadPromise;
  const exportPath = await download.path();
  expect(exportPath).toBeTruthy();
  await page.locator('input[type="file"]').setInputFiles(exportPath!);
  await expect(page.getByText(/Import complete/)).toBeVisible();
});

test("dashboard and project detail remain usable on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Project memory" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});
