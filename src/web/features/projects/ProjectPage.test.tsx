import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./ProjectPage";

const id = "11111111-1111-4111-8111-111111111111";
const project = {
  id,
  title: "Signal Garden",
  description: "A distributed garden-sensing system.",
  intent: null,
  deadline: null,
  completionCriteria: null,
  state: "active",
  currentFocus: "Adaptive antenna array firmware",
  nextAction: "Implement phase calibration routine",
  blockers: ["Waiting on low-noise amplifiers"],
  currentCheckpointId: null,
  archivedAt: null,
  version: 3,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-09T10:00:00.000Z",
  lastActivityAt: "2026-07-10T10:30:00.000Z",
};
const detail = {
  project,
  pulse: { state: "active", currentFocus: project.currentFocus, nextAction: project.nextAction, blockers: project.blockers, currentCheckpoint: null, activePhases: [], unresolvedWorkItems: [] },
  phases: [],
  workItems: [],
  updates: [],
  labels: [],
  activity: [],
};

function response(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectPage", () => {
  it("renders the pulse and records a structured checkpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/phases")) return response([]);
      if (url.includes("/checkpoints") && init?.method === "POST") return response({ id: "checkpoint-1" });
      return response(detail);
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/projects/${id}`]}>
        <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Signal Garden" })).toBeInTheDocument();
    expect(screen.getByText("Waiting on low-noise amplifiers")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Record checkpoint" }));
    await user.type(screen.getByLabelText("What changed?"), "Deployed firmware v0.3.2 to the field mesh.");
    await user.click(screen.getByRole("button", { name: "Save checkpoint" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/checkpoints"))).toBe(true));
    const checkpointCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/checkpoints"));
    expect(JSON.parse(String(checkpointCall?.[1]?.body))).toMatchObject({
      expectedVersion: 3,
      currentFocus: "Adaptive antenna array firmware",
      nextAction: "Implement phase calibration routine",
      blockers: ["Waiting on low-noise amplifiers"],
    });
  });
});
