import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { QueueAutomationOverview } from "../../types";

interface QueueAutomationOverviewState {
  data: QueueAutomationOverview | null;
  error: Error | null;
  liveError: Error | null;
  loading: boolean;
  reload: () => void;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Something went wrong");
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

export function useQueueAutomationOverview(
  projectId: string,
  queueId: string,
  onEligibilityChanged: () => void | Promise<void>,
): QueueAutomationOverviewState {
  const [state, setState] = useState<Omit<QueueAutomationOverviewState, "reload">>({ data: null, error: null, liveError: null, loading: Boolean(queueId) });
  const [reloadVersion, setReloadVersion] = useState(0);
  const generation = useRef(0);
  const eligibilityChanged = useRef(onEligibilityChanged);
  eligibilityChanged.current = onEligibilityChanged;

  const reload = useCallback(() => setReloadVersion((version) => version + 1), []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    const current = () => generation.current === currentGeneration && !controller.signal.aborted;

    setState({ data: null, error: null, liveError: null, loading: Boolean(queueId) });
    if (!queueId) return () => controller.abort();

    async function run() {
      try {
        let snapshot = await api.getQueueAutomationOverview(projectId, queueId, controller.signal);
        if (!current()) return;
        setState({ data: snapshot, error: null, liveError: null, loading: false });

        for (;;) {
          const feed = await api.waitForQueueAutomationChanges(projectId, queueId, snapshot.cursor, controller.signal);
          if (!current()) return;
          if (!feed.changes.length) {
            snapshot = { ...snapshot, cursor: feed.cursor };
            continue;
          }

          snapshot = await api.getQueueAutomationOverview(projectId, queueId, controller.signal);
          if (!current()) return;
          setState({ data: snapshot, error: null, liveError: null, loading: false });
          await eligibilityChanged.current();
        }
      } catch (cause) {
        if (!current() || isAbort(cause)) return;
        const error = asError(cause);
        setState((existing) => existing.data
          ? { ...existing, liveError: error, loading: false }
          : { data: null, error, liveError: null, loading: false });
      }
    }

    void run();
    return () => controller.abort();
  }, [projectId, queueId, reloadVersion]);

  return { ...state, reload };
}
