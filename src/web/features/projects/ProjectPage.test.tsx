import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
const operationalPulse = {
  project,
  currentCheckpoint: null,
  activePhases: [],
  requirementRollup: {
    total: 12,
    bySemantic: { open: 5, partial: 2, proven: 3, defect: 2 },
    gateFailures: 4,
    defects: 2,
    byCapability: [],
    byMilestone: [],
    byGoal: [],
  },
  queueHead: [
    { id: "work-1", effectiveBlocked: true },
    { id: "work-2", effectiveBlocked: false },
  ],
  blockers: [{ id: "blocker-1" }],
  staleEvidenceCount: 3,
  failedEvidenceCount: 1,
};
const requirementsPage = {
  items: [{ id: "requirement-1", stableKey: "REQ-1", title: "Broken authentication", gate: "satisfied" }],
  nextCursor: null,
  hasMore: false,
};

function response(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } }));
}

function failure(message: string) {
  return Promise.resolve(new Response(JSON.stringify({ error: { message } }), { status: 500, headers: { "Content-Type": "application/json" } }));
}

function projectPageResponse(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  if (url.endsWith(`/projects/${id}`)) return response(detail);
  if (url.endsWith(`/projects/${id}/pulse`)) return response(operationalPulse);
  if (url.includes(`/projects/${id}/requirements/page`)) return response(requirementsPage);
  if (url.includes("/phases")) return response([]);
  if (url.endsWith("/labels")) return response([]);
  if (url.includes("/checkpoints") && init?.method === "POST") return response({ id: "checkpoint-1" });
  return response([]);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectPage", () => {
  it("renders the pulse and records a structured checkpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(projectPageResponse);
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
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(`/projects/${id}/pulse`))).toHaveLength(2));
    const checkpointCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/checkpoints"));
    expect(JSON.parse(String(checkpointCall?.[1]?.body))).toMatchObject({
      expectedVersion: 3,
      currentFocus: "Adaptive antenna array firmware",
      nextAction: "Implement phase calibration routine",
      blockers: ["Waiting on low-noise amplifiers"],
    });
  });

  it("uses the authoritative operational summary and bounded requirement ledger", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(projectPageResponse);

    render(
      <MemoryRouter initialEntries={[`/projects/${id}`]}>
        <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Signal Garden" })).toBeInTheDocument();
    const requirementsCard = screen.getByText("Requirements").closest(".operational-memory-card") as HTMLElement | null;
    expect(requirementsCard).not.toBeNull();
    expect(within(requirementsCard!).getByText("12")).toBeInTheDocument();
    expect(within(requirementsCard!).getByText("3 proven · 4 gate failures · 2 defects")).toBeInTheDocument();
    expect(await screen.findByText("REQ-1")).toBeInTheDocument();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes(`/requirements/page?limit=8`))).toBe(true);
    expect(urls.some((url) => /\/runs(?:\?|$)/.test(url))).toBe(false);
    expect(urls.some((url) => /\/evidence(?:\?|$)/.test(url))).toBe(false);
    expect(urls.some((url) => /\/operational-work-items(?:\?|$)/.test(url))).toBe(false);
  });

  it("keeps operational memory loading until every resource resolves", async () => {
    let resolveRequirements: (response: Response) => void = () => undefined;
    const pendingRequirements = new Promise<Response>((resolve) => { resolveRequirements = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes(`/projects/${id}/requirements/page`)) return pendingRequirements;
      return projectPageResponse(input, init);
    });

    render(
      <MemoryRouter initialEntries={[`/projects/${id}`]}>
        <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Signal Garden" })).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.queryByText(/No requirements recorded yet/)).not.toBeInTheDocument();

    await act(async () => {
      resolveRequirements(new Response(JSON.stringify({ data: requirementsPage }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    expect(await screen.findByText("Live")).toBeInTheDocument();
  });

  it("shows an operational error instead of live zero counts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith(`/projects/${id}/pulse`)) return failure("Operational store unavailable");
      return projectPageResponse(input, init);
    });

    render(
      <MemoryRouter initialEntries={[`/projects/${id}`]}>
        <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Signal Garden" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Operational store unavailable");
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("refreshes operational memory after saving a work item", async () => {
    let pulseCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith(`/projects/${id}/pulse`)) {
        pulseCalls += 1;
        return response({
          ...operationalPulse,
          queueHead: pulseCalls === 1 ? operationalPulse.queueHead.slice(0, 1) : operationalPulse.queueHead,
        });
      }
      if (url.endsWith(`/projects/${id}/work-items`) && init?.method === "POST") return response({ id: "work-2" });
      return projectPageResponse(input, init);
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={[`/projects/${id}`]}>
        <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Signal Garden" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add work item" }));
    await user.type(screen.getByLabelText("Title"), "Calibrate receiver");
    await user.click(screen.getByRole("button", { name: "Save work item" }));

    await waitFor(() => expect(pulseCalls).toBe(2));
    const queueCard = screen.getByText("Queue head").closest(".operational-memory-card") as HTMLElement | null;
    expect(queueCard).not.toBeNull();
    expect(within(queueCard!).getByText("2")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith(`/projects/${id}/work-items`) && init?.method === "POST")).toBe(true);
  });

  it("refreshes operational memory after project and phase edits", async () => {
    let pulseCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).endsWith(`/projects/${id}/pulse`)) pulseCalls += 1;
      return projectPageResponse(input, init);
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={[`/projects/${id}`]}>
        <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Signal Garden" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit project details" }));
    await user.click(screen.getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(pulseCalls).toBe(2));

    await user.click(screen.getByRole("button", { name: "Add phase" }));
    await user.type(screen.getByLabelText("Name"), "Field calibration");
    await user.click(screen.getByRole("button", { name: "Save phase" }));
    await waitFor(() => expect(pulseCalls).toBe(3));
  });
});
