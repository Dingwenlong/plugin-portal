import { createContext, type ReactNode, useContext, useEffect } from "react";
import { createPortal } from "react-dom";

interface PortalShellOutletContextValue {
  actionTarget: HTMLElement | null;
  onModalStateChange?: (open: boolean) => void;
}

const PortalShellOutletContext = createContext<PortalShellOutletContextValue>({ actionTarget: null });

export function PortalPageActionTargetProvider({
  children,
  onModalStateChange,
  target,
}: {
  children: ReactNode;
  onModalStateChange?: (open: boolean) => void;
  target: HTMLElement | null;
}) {
  return (
    <PortalShellOutletContext.Provider value={{ actionTarget: target, onModalStateChange }}>
      {children}
    </PortalShellOutletContext.Provider>
  );
}

export function PortalPageAction({ children }: { children: ReactNode }) {
  const { actionTarget } = useContext(PortalShellOutletContext);
  return actionTarget ? createPortal(children, actionTarget) : children;
}

export function usePortalModalPresence() {
  const { onModalStateChange } = useContext(PortalShellOutletContext);
  useEffect(() => {
    onModalStateChange?.(true);
    return () => onModalStateChange?.(false);
  }, [onModalStateChange]);
}
