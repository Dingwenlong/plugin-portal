import { useEffect, useRef, useState } from "react";
import { errorMessage, isUncertain, PortalRequestError } from "./requestState";

/** Keeps the exact attempted value; an unknown write result is never replayed. */
export function useSaveRecovery<T>(checkSaved?: (value: T) => Promise<boolean>, onSuccess?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<T>();
  const [conflict, setConflict] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  type Attempt = { value: T; checkSaved: typeof checkSaved; onSuccess: typeof onSuccess };
  const attempted = useRef<Attempt | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const confirm = async (attempt: Attempt) => {
    try {
      if (await attempt.checkSaved?.(attempt.value)) {
        if (alive.current) {
          attempted.current = undefined;
          setPending(undefined); setError(""); attempt.onSuccess?.();
        }
        return true;
      }
    } catch { /* Failed reads cannot prove a write failed. */ }
    if (alive.current) setError("结果待确认。草稿已保留，请核对保存结果，不要重复提交。");
    return false;
  };
  const run = async (value: T, write: (frozen: T) => Promise<unknown>) => {
    if (locked.current || attempted.current) return;
    locked.current = true; setBusy(true); setError(""); setConflict(false);
    let attempt: Attempt | undefined;
    try {
      attempt = { value: structuredClone(value), checkSaved, onSuccess };
      await write(attempt.value);
      if (alive.current) attempt.onSuccess?.();
    } catch (reason) {
      if (!alive.current) return;
      if (isUncertain(reason) && attempt) {
        attempted.current = attempt;
        setPending(attempt.value);
        await confirm(attempt);
      }
      else { setError(errorMessage(reason)); setConflict(reason instanceof PortalRequestError && reason.code === "revision_conflict"); }
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const check = async () => {
    const attempt = attempted.current;
    if (locked.current || !attempt) return;
    locked.current = true; setBusy(true);
    try { await confirm(attempt); } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return { busy, error, pending: pending !== undefined, frozen: pending, conflict, run, check };
}
