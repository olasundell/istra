import { useCallback, useEffect, useState } from "react";

export interface ResourceState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useResource<T>(loader: () => Promise<T>, dependencies: readonly unknown[]): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loader());
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Something went wrong"));
    } finally {
      setLoading(false);
    }
    // The caller controls loader invalidation through the primitive dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

