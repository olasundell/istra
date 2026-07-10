import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Signal Garden",
  description: "A garden-sensing system.",
  intent: null,
  deadline: null,
  completionCriteria: null,
  state: "active",
  currentFocus: "Adaptive antenna array firmware",
  nextAction: "Implement phase calibration routine",
  blockers: [],
  currentCheckpointId: null,
  archivedAt: null,
  version: 1,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-02T10:00:00.000Z",
  lastActivityAt: "2026-07-09T10:00:00.000Z",
};

function response(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DashboardPage", () => {
  it("renders real global activity and the project pulse", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/activity")) return response([{
        id: "event-1",
        projectId: project.id,
        projectTitle: project.title,
        entityType: "update",
        entityId: "update-1",
        eventType: "decision",
        payload: { summary: "Adopted the dual-antenna layout" },
        source: "ui",
        client: null,
        createdAt: "2026-07-10T10:30:00.000Z",
      }]);
      return response([project]);
    });

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Signal Garden" })).toBeInTheDocument();
    expect(screen.getByText("Adaptive antenna array firmware")).toBeInTheDocument();
    expect(await screen.findByText("Adopted the dual-antenna layout")).toBeInTheDocument();
    expect(screen.getByText("9 Jul 2026")).toBeInTheDocument();
  });

  it("refreshes projects and recent activity after creating a project", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === "POST") return response(project);
      if (url.includes("/activity")) return response([]);
      return response([]);
    });
    const user = userEvent.setup();
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByLabelText("Project title"), "Signal Garden");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/projects")).length).toBeGreaterThanOrEqual(3);
      expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/activity")).length).toBeGreaterThanOrEqual(2);
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ title: "Signal Garden", source: "ui" });
  });
});
