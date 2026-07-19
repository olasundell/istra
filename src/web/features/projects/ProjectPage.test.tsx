import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./ProjectPage";
import { useQueueAutomationOverview } from "./useQueueAutomationOverview";

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
    byProofStatus: { open: 2, partial: 1, proven: 7, defect: 2 },
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
  items: [{ id: "requirement-1", stableKey: "REQ-1", title: "Broken authentication", gate: "satisfied", proofStatus: "defect" }],
  nextCursor: null,
  hasMore: false,
};
const queueId = "22222222-2222-4222-8222-222222222222";
const workQueue = { id: queueId, projectId: id, name: "Main queue", description: "Default queue", version: 1, createdAt: "2026-07-01T10:00:00.000Z", updatedAt: "2026-07-01T10:00:00.000Z" };
const automationPolicy = { queueId, projectId: id, enabled: false, allowedKinds: ["issue", "task"], maxActiveClaims: 1, leaseSeconds: 900, requiresManualApproval: true, allowSameWorkerRecovery: true, version: 0, createdAt: workQueue.createdAt, updatedAt: workQueue.updatedAt };
const emptyAutomationOverview = { policy: automationPolicy, activeLeases: [], expiredLeases: [], lastAttempt: null, cursor: "cursor-1" };
const activeLease = {
  id: "33333333-3333-4333-8333-333333333333",
  projectId: id,
  queueId,
  workItemId: "44444444-4444-4444-8444-444444444444",
  workItemTitle: "Automate calibration",
  workItemStatus: "in_progress",
  workerId: "workshop-a",
  claimedWorkItemVersion: 2,
  acquiredAt: "2026-07-10T10:00:00.000Z",
  heartbeatAt: "2026-07-10T10:01:00.000Z",
  expiresAt: "2026-07-10T10:16:00.000Z",
  releasedAt: null,
  releaseReason: null,
  terminalOutcome: null,
  version: 1,
  state: "active",
};
const automatedWorkItem = {
  id: activeLease.workItemId,
  projectId: id,
  phaseId: null,
  kind: "task",
  title: activeLease.workItemTitle,
  description: null,
  status: "open",
  priority: "high",
  labels: [],
  version: 1,
  createdAt: "2026-07-10T09:00:00.000Z",
  updatedAt: "2026-07-10T09:00:00.000Z",
  queueId,
};

function response(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } }));
}

function failure(message: string) {
  return Promise.resolve(new Response(JSON.stringify({ error: { message } }), { status: 500, headers: { "Content-Type": "application/json" } }));
}

function pendingResponse() {
  return new Promise<Response>(() => undefined);
}

function projectPageResponse(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  if (url.includes(`/projects/${id}/work-queues/${queueId}/automation/wait`)) return pendingResponse();
  if (url.endsWith(`/projects/${id}/work-queues/${queueId}/automation`)) return response(emptyAutomationOverview);
  if (url.endsWith(`/projects/${id}/work-queues`)) return response([workQueue]);
  if (url.endsWith(`/projects/${id}`)) return response(detail);
  if (url.endsWith(`/projects/${id}/pulse`)) return response(operationalPulse);
  if (url.includes(`/projects/${id}/requirements/page`)) return response(requirementsPage);
  if (url.includes("/phases")) return response([]);
  if (url.endsWith("/labels")) return response([]);
  if (url.includes("/checkpoints") && init?.method === "POST") return response({
    checkpoint: { id: "checkpoint-1" },
    snapshot: {
      id: "snapshot-1",
      digest: "a".repeat(64),
      schemaVersion: 3,
      capturedAt: "2026-07-10T11:00:00.000Z",
    },
  });
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
    expect(within(requirementsCard!).getByText("7 proven · 4 gate failures · 2 defects")).toBeInTheDocument();
    expect(await screen.findByText("REQ-1")).toBeInTheDocument();
    expect(screen.getByText("Defect")).toHaveClass("requirement-gate--defect");

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes(`/requirements/page?limit=8`))).toBe(true);
    expect(urls.some((url) => /\/runs(?:\?|$)/.test(url))).toBe(false);
    expect(urls.some((url) => /\/evidence(?:\?|$)/.test(url))).toBe(false);
    expect(urls.some((url) => /\/operational-work-items(?:\?|$)/.test(url))).toBe(false);
  });

  it("explicitly configures queue automation with client and idempotency headers", async () => {
    let enabled = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith(`/projects/${id}/work-queues/${queueId}/automation`)) return response({ ...emptyAutomationOverview, policy: { ...automationPolicy, enabled, version: enabled ? 1 : 0 } });
      if (url.endsWith(`/projects/${id}/work-queues/${queueId}/automation-policy`) && init?.method === "PUT") { enabled = true; return response({ ...automationPolicy, enabled, version: 1 }); }
      return projectPageResponse(input, init);
    });
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/projects/${id}`]}><Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Automation" })).toBeInTheDocument();
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configure policy" }));
    await user.click(screen.getByLabelText("Enable automated claiming"));
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByText("Enabled")).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/automation-policy") && init?.method === "PUT");
    expect(call).toBeDefined();
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("x-istra-client")).toBe("istra-web");
    expect(headers.get("idempotency-key")).toMatch(/.+/);
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ enabled: true, expectedVersion: null, allowedKinds: ["issue", "task"] });
  });

  it("shows active leases without tokens and confirms operator release", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let active = true;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith(`/projects/${id}/work-queues/${queueId}/automation`)) return response({ ...emptyAutomationOverview, policy: { ...automationPolicy, enabled: true, version: 1 }, activeLeases: active ? [activeLease] : [], cursor: active ? "cursor-active" : "cursor-released" });
      if (url.includes("/automation-leases/") && url.endsWith("/operator-release") && init?.method === "POST") { active = false; return response({ outcome: "interrupted", item: { status: "open" } }); }
      return projectPageResponse(input, init);
    });
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/projects/${id}`]}><Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByText(/worker workshop-a/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("leaseToken");
    await user.click(screen.getByRole("button", { name: "Release lease for Automate calibration held by workshop-a" }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("workshop-a")).not.toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/operator-release"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ reason: "manual", expectedLeaseVersion: 1 });
    expect(new Headers(call?.[1]?.headers).get("idempotency-key")).toMatch(/.+/);
  });

  it("requires at least one eligible kind before saving a policy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(projectPageResponse);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/projects/${id}`]}><Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "Configure policy" }));
    await user.click(screen.getByLabelText("Issue"));
    await user.click(screen.getByLabelText("Task"));
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Select at least one eligible work-item kind.");
    expect(screen.getByLabelText("Issue")).toHaveFocus();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/automation-policy") && init?.method === "PUT")).toBe(false);
  });

  it("does not expose the previous queue policy while a new queue loads", async () => {
    const secondQueueId = "55555555-5555-4555-8555-555555555555";
    const secondQueue = { ...workQueue, id: secondQueueId, name: "Secondary queue" };
    const secondPolicy = { ...automationPolicy, queueId: secondQueueId, enabled: true, version: 2 };
    let resolveSecond: (value: Response) => void = () => undefined;
    const pendingSecond = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    let secondOverviewCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith(`/projects/${id}/work-queues`)) return response([workQueue, secondQueue]);
      if (url.includes(`/projects/${id}/work-queues/${secondQueueId}/automation/wait`)) return pendingResponse();
      if (url.endsWith(`/projects/${id}/work-queues/${secondQueueId}/automation`)) {
        secondOverviewCalls += 1;
        return secondOverviewCalls === 1 ? pendingSecond : response({ ...emptyAutomationOverview, policy: secondPolicy, cursor: "cursor-secondary" });
      }
      if (url.endsWith(`/projects/${id}/work-queues/${secondQueueId}/automation-policy`) && init?.method === "PUT") return response(secondPolicy);
      return projectPageResponse(input, init);
    });
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/projects/${id}`]}><Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes></MemoryRouter>);

    await screen.findByText("Disabled");
    await user.selectOptions(screen.getByLabelText("Automation queue"), secondQueueId);
    expect(screen.queryByRole("button", { name: "Configure policy" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading queue automation…")).toBeInTheDocument();

    await act(async () => resolveSecond(new Response(JSON.stringify({ data: { ...emptyAutomationOverview, policy: secondPolicy, cursor: "cursor-secondary" } }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await user.click(await screen.findByRole("button", { name: "Configure policy" }));
    expect(screen.getByRole("dialog", { name: "Automation · Secondary queue" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith(`/${secondQueueId}/automation-policy`) && init?.method === "PUT")).toBe(true));
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith(`/${queueId}/automation-policy`) && init?.method === "PUT")).toBe(false);
  });

  it("refreshes an externally claimed lease and its visible work item through the queue feed", async () => {
    let overviewCalls = 0;
    let detailCalls = 0;
    let resolveWait: (value: Response) => void = () => undefined;
    const feedChange = new Promise<Response>((resolve) => { resolveWait = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes(`/projects/${id}/work-queues/${queueId}/automation/wait`)) return overviewCalls === 1 ? feedChange : pendingResponse();
      if (url.endsWith(`/projects/${id}/work-queues/${queueId}/automation`)) {
        overviewCalls += 1;
        return response({ ...emptyAutomationOverview, activeLeases: overviewCalls > 1 ? [activeLease] : [], cursor: `cursor-${overviewCalls}` });
      }
      if (url.endsWith(`/projects/${id}`)) {
        detailCalls += 1;
        return response({
          ...detail,
          workItems: [{ ...automatedWorkItem, status: detailCalls > 1 ? "in_progress" : "open", version: detailCalls }],
        });
      }
      return projectPageResponse(input, init);
    });
    render(<MemoryRouter initialEntries={[`/projects/${id}`]}><Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByText("No unreleased runner lease.")).toBeInTheDocument();
    const initialWorkItemRow = screen.getByRole("cell", { name: "Automate calibration" }).closest('[role="row"]') as HTMLElement | null;
    expect(initialWorkItemRow).not.toBeNull();
    expect(within(initialWorkItemRow!).getByText("Open")).toBeInTheDocument();
    await act(async () => resolveWait(new Response(JSON.stringify({ data: { cursor: "cursor-event", timedOut: false, changes: [{ sequence: 1 }] } }), { status: 200, headers: { "Content-Type": "application/json" } })));

    expect(await screen.findByText(/worker workshop-a/)).toBeInTheDocument();
    await waitFor(() => {
      const currentWorkItemRow = screen.getByRole("cell", { name: "Automate calibration" }).closest('[role="row"]') as HTMLElement | null;
      expect(currentWorkItemRow).not.toBeNull();
      expect(within(currentWorkItemRow!).getByText("In progress")).toBeInTheDocument();
    });
    expect(overviewCalls).toBe(2);
    expect(detailCalls).toBe(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(`/projects/${id}/work-queues/${queueId}/automation`))).toHaveLength(2);
  });

  it("shows expired leases as recoverable operator work", async () => {
    const expiredLease = { ...activeLease, state: "expired", version: 3 };
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith(`/projects/${id}/work-queues/${queueId}/automation`)) return response({ ...emptyAutomationOverview, activeLeases: [], expiredLeases: [expiredLease] });
      return projectPageResponse(input, init);
    });
    render(<MemoryRouter initialEntries={[`/projects/${id}`]}><Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Expired leases requiring recovery" })).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release lease for Automate calibration held by workshop-a" })).toBeInTheDocument();
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

describe("useQueueAutomationOverview", () => {
  it("ignores a late overview response after the queue changes", async () => {
    const secondQueueId = "55555555-5555-4555-8555-555555555555";
    let resolveFirst: (value: Response) => void = () => undefined;
    const pendingFirst = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith(`/projects/${id}/work-queues/${queueId}/automation`)) return pendingFirst;
      if (url.endsWith(`/projects/${id}/work-queues/${secondQueueId}/automation`)) return response({ ...emptyAutomationOverview, policy: { ...automationPolicy, queueId: secondQueueId }, cursor: "cursor-second" });
      if (url.includes(`/projects/${id}/work-queues/${secondQueueId}/automation/wait`)) return pendingResponse();
      return pendingResponse();
    });

    function Harness({ selectedQueueId }: { selectedQueueId: string }) {
      const overview = useQueueAutomationOverview(id, selectedQueueId, () => undefined);
      return <p>{overview.data?.policy.queueId ?? "loading"}</p>;
    }

    const view = render(<Harness selectedQueueId={queueId} />);
    view.rerender(<Harness selectedQueueId={secondQueueId} />);
    expect(await screen.findByText(secondQueueId)).toBeInTheDocument();

    await act(async () => resolveFirst(new Response(JSON.stringify({ data: emptyAutomationOverview }), { status: 200, headers: { "Content-Type": "application/json" } })));
    expect(screen.getByText(secondQueueId)).toBeInTheDocument();
    expect(screen.queryByText(queueId)).not.toBeInTheDocument();
  });
});
