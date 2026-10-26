import { useEffect, useRef, useState } from "react";
import { PortalModal, PORTAL_NAVIGATION_EVENT } from "../PortalModal";

export function useWorkflowExitGuard({ onExit, dirty, busy, pending }: {
  onExit?: () => void; dirty: boolean; busy: boolean; pending: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const navigation = useRef<(() => void) | undefined>(undefined);
  const current = useRef({ onExit, dirty, busy, pending });
  current.current = { onExit, dirty, busy, pending };
  const requestExit = () => {
    if (current.current.busy) return;
    if (current.current.dirty || current.current.pending) setConfirming(true);
    else current.current.onExit?.();
  };
  useEffect(() => {
    if (!onExit) return;
    const beforeNavigation = (event: Event) => {
      const state = current.current;
      if (!state.busy && !state.dirty && !state.pending) return;
      event.preventDefault();
      if (state.busy) return;
      navigation.current = (event as CustomEvent<() => void>).detail;
      setConfirming(true);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const state = current.current;
      if (state.dirty || state.busy || state.pending) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener(PORTAL_NAVIGATION_EVENT, beforeNavigation);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener(PORTAL_NAVIGATION_EVENT, beforeNavigation);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [Boolean(onExit)]);
  const keepEditing = () => { navigation.current = undefined; setConfirming(false); };
  const confirmation = confirming ? <PortalModal title="退出流程编辑" onClose={keepEditing}>
    <p>{pending ? "保存结果尚待确认。退出不会撤回已发送的请求，请稍后核对。" : "有尚未保存的修改，确定放弃并退出吗？"}</p>
    <div className="modal-actions">
      <button onClick={keepEditing} type="button">继续编辑</button>
      <button disabled={busy} onClick={() => {
        if (current.current.busy) return;
        const proceed = navigation.current;
        navigation.current = undefined;
        setConfirming(false);
        current.current.onExit?.();
        proceed?.();
      }} type="button">{pending ? "退出并稍后核对" : "放弃并退出"}</button>
    </div>
  </PortalModal> : null;
  return { requestExit, confirmation };
}
