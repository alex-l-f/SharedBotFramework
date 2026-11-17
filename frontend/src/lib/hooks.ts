import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Runs `fn` on mount and whenever `deps` change; exposes data/error/loading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

function readStorage<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? initial : (JSON.parse(raw) as T);
  } catch {
    return initial;
  }
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: readStorage(key, initial) }));
  const value = state.key === key ? state.value : readStorage(key, initial);
  const set = useCallback(
    (v: T) => {
      setState({ key, value: v });
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}

// Editors with unsaved changes right now (signing out asks first).
let unsavedCount = 0;

export function anyUnsaved(): boolean {
  return unsavedCount > 0;
}

/**
 * Confirms before leaving a page with unsaved changes (in-app navigation and
 * tab close). Call the returned `allowNext()` right before a navigation that
 * should not be blocked (e.g. after creating an item).
 */
export function useUnsavedGuard(dirty: boolean): { allowNext: () => void } {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bypass = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    unsavedCount++;
    return () => {
      unsavedCount--;
    };
  }, [dirty]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (bypass.current) {
      bypass.current = false;
      return false;
    }
    return dirtyRef.current && currentLocation.pathname !== nextLocation.pathname;
  });

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('You have unsaved changes. Leave this page and discard them?')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const allowNext = useCallback(() => {
    bypass.current = true;
  }, []);
  return { allowNext };
}

/** Ctrl/Cmd+S handler. */
export function useSaveShortcut(onSave: () => void, enabled = true): void {
  const ref = useRef(onSave);
  ref.current = onSave;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled]);
}

/** Drag-to-resize: returns a mousedown handler for a splitter element. */
export function useDragResize(
  value: number,
  setValue: (v: number) => void,
  axis: 'x' | 'y',
  direction: 1 | -1,
  min: number,
  max: number,
): (e: React.MouseEvent) => void {
  return useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const start = axis === 'x' ? e.clientX : e.clientY;
      const startValue = value;
      const move = (ev: MouseEvent) => {
        const pos = axis === 'x' ? ev.clientX : ev.clientY;
        setValue(Math.round(Math.min(max, Math.max(min, startValue + direction * (pos - start)))));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
      };
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [value, setValue, axis, direction, min, max],
  );
}
