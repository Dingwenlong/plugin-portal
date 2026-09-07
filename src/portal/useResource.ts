import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type ResourceState } from "./requestState";

export function useResource<T>(key: string | undefined, load: (key: string, signal: AbortSignal) => Promise<T>, revision = 0) {
  const [state, setState] = useState<ResourceState<T> & { key?: string }>({ status: "loading" });
  const request = useRef<AbortController | null>(null);
  const currentKey = useRef(key);
  const mounted = useRef(true);
  const identity = useRef({ key, revision, generation: 0 });
  if (identity.current.key !== key || identity.current.revision !== revision) {
    identity.current = { key, revision, generation: identity.current.generation + 1 };
  }
  const generation = identity.current.generation;
  currentKey.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (!key || identity.current.generation !== generation || !mounted.current) return undefined;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((old) => ({ key, value: old.key === key ? old.value : undefined, status: "loading" }));
    try {
      const value = await load(key, controller.signal);
      if (!controller.signal.aborted && currentKey.current === key && identity.current.generation === generation && mounted.current) {
        setState({ key, status: "ready", value });
        return value;
      }
      return undefined;
    } catch (error) {
      if (!controller.signal.aborted && currentKey.current === key && identity.current.generation === generation && mounted.current) setState((old) => ({ ...old, key, status: "error", error: errorMessage(error) }));
      throw error;
    }
  }, [key, load, generation]);
  useEffect(() => {
    void refresh().catch(() => undefined);
    return () => { request.current?.abort(); };
  }, [refresh, revision]);
  const update = useCallback((value: T) => {
    if (!key || currentKey.current !== key || identity.current.generation !== generation || !mounted.current) return false;
    request.current?.abort();
    setState({ key, status: "ready", value });
    return true;
  }, [key, generation]);
  return { ...(state.key === key ? state : { status: "loading" as const }), refresh, update };
}
