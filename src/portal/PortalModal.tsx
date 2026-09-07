import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";

import { usePortalModalPresence } from "./PortalPageAction";

const ModalGuard = createContext<((guard: { dirty: boolean; busy: boolean }) => void) | undefined>(undefined);
const ModalClose = createContext<(() => void) | undefined>(undefined);
const NAVIGATION_EVENT = "portal-before-navigation";
export function requestPortalNavigation(proceed: () => void): boolean {
  return window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT, { cancelable: true, detail: proceed }));
}
export function ModalCancelButton() {
  return <button onClick={useContext(ModalClose)} type="button">取消</button>;
}
export function useModalGuard(dirty: boolean, busy: boolean) {
  const setGuard = useContext(ModalGuard);
  useEffect(() => {
    setGuard?.({ dirty, busy });
    return () => setGuard?.({ dirty: false, busy: false });
  }, [setGuard, dirty, busy]);
}

export function PortalModal({
  title,
  onClose,
  children,
  wide = false,
  dirty = false,
  busy = false,
  returnFocusRef,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  dirty?: boolean;
  busy?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  usePortalModalPresence();
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [guard, setGuard] = useState({ dirty: false, busy: false });
  const [confirmClose, setConfirmClose] = useState(false);
  const pendingNavigation = useRef<(() => void) | undefined>(undefined);
  const discard = () => {
    if (guard.busy || busy) return;
    onClose();
    pendingNavigation.current?.();
  };
  const requestClose = () => {
    if (guard.busy || busy) return;
    if (guard.dirty || dirty) setConfirmClose(true);
    else onClose();
  };
  const closeRequest = useRef(requestClose);
  closeRequest.current = requestClose;

  useEffect(() => {
    const beforeNavigation = (event: Event) => {
      if (guard.busy || busy || guard.dirty || dirty) {
        event.preventDefault();
        if (!guard.busy && !busy) {
          pendingNavigation.current = (event as CustomEvent<() => void>).detail;
          setConfirmClose(true);
        }
      } else onClose();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (guard.busy || busy || guard.dirty || dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener(NAVIGATION_EVENT, beforeNavigation);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, beforeNavigation);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [guard, busy, dirty, onClose]);

  useEffect(() => {
    const openingControl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableElements = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex='0']") ?? [])
      .filter((element) => !element.matches(":disabled") && !element.hidden && !element.closest("[hidden]") && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden" && (!element.closest("details:not([open])") || element.tagName === "SUMMARY"));
    const focusFirst = () => (focusableElements()[0] ?? dialogRef.current)?.focus();
    (focusableElements().find((element) => element.hasAttribute("data-autofocus")) ?? focusableElements()[0] ?? dialogRef.current)?.focus();
    const containFocus = (event: FocusEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) focusFirst();
    };
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); closeRequest.current(); return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements();
      const first = elements[0];
      const last = elements.at(-1);
      if (!elements.includes(document.activeElement as HTMLElement)) { event.preventDefault(); focusFirst(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    document.addEventListener("focusin", containFocus);
    // Disabling or removing the focused control may move focus to body without
    // emitting focusin. Keep that transition inside the same modal too.
    const observer = new MutationObserver(() => {
      if (dialogRef.current && (!dialogRef.current.contains(document.activeElement) || document.activeElement?.matches(":disabled"))) focusFirst();
    });
    if (dialogRef.current) observer.observe(dialogRef.current, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", trap);
      document.removeEventListener("focusin", containFocus);
      observer.disconnect();
      document.body.style.overflow = previousOverflow;
      const target = returnFocusRef?.current ?? openingControl;
      if (target?.isConnected && target !== document.body) target.focus();
    };
  }, []);

  return (
    <div className="portal-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={`portal-modal${wide ? " portal-modal-wide" : ""}`}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button aria-label="关闭" disabled={guard.busy || busy} onClick={requestClose} type="button">×</button>
        </header>
        {confirmClose && <div className="portal-resource-notice" role="alert">
          <p>有尚未保存的内容。确定关闭并放弃吗？</p>
          <button onClick={() => { setConfirmClose(false); pendingNavigation.current = undefined; }} type="button">继续编辑</button>
          <button disabled={guard.busy || busy} onClick={discard} type="button">放弃并关闭</button>
        </div>}
        <ModalGuard.Provider value={setGuard}><ModalClose.Provider value={requestClose}>{children}</ModalClose.Provider></ModalGuard.Provider>
      </section>
    </div>
  );
}
