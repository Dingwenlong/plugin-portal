import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef } from "react";

interface PortalShellOutletContextValue {
  onModalStateChange?: (open: boolean) => void;
}

const PortalShellOutletContext = createContext<PortalShellOutletContextValue>({});

export function PortalPresenceProvider({
  children,
  onModalStateChange,
}: {
  children: ReactNode;
  onModalStateChange?: (open: boolean) => void;
}) {
  const presenceCount = useRef(0);
  const reportPresence = useCallback((open: boolean) => {
    presenceCount.current = Math.max(0, presenceCount.current + (open ? 1 : -1));
    onModalStateChange?.(presenceCount.current > 0);
  }, [onModalStateChange]);
  return (
    <PortalShellOutletContext.Provider value={{ onModalStateChange: reportPresence }}>
      {children}
    </PortalShellOutletContext.Provider>
  );
}

export function usePortalModalPresence() {
  const { onModalStateChange } = useContext(PortalShellOutletContext);
  useEffect(() => {
    onModalStateChange?.(true);
    return () => onModalStateChange?.(false);
  }, [onModalStateChange]);
}
