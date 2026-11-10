import type { Page } from '@hqps/contracts';
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface PagedState<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Offset-paginated list. Resets when `deps` change; `loadMore` appends the next page.
 * Responses from a superseded deps set are ignored.
 */
export function usePaged<T>(
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>,
  deps: DependencyList,
  pageSize = 200,
): PagedState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const load = useCallback(
    (offset: number, gen: number) => {
      setLoading(true);
      setError(null);
      fetchRef
        .current(offset, pageSize)
        .then((page) => {
          if (gen !== generation.current) return;
          setTotal(page.total);
          setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        })
        .catch((err: unknown) => {
          if (gen !== generation.current) return;
          setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (gen === generation.current) setLoading(false);
        });
    },
    [pageSize],
  );

  useEffect(() => {
    generation.current += 1;
    load(0, generation.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller
  }, [...deps, tick, load]);

  const loadMore = useCallback(() => {
    if (loading) return;
    load(items.length, generation.current);
  }, [items.length, load, loading]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  return { items, total, loading, error, hasMore: items.length < total, loadMore, reload };
}
