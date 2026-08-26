import { useEffect, useId, useRef, type ReactNode } from "react";

export function PortalModal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const focusable = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")
      ?? dialogRef.current?.querySelector<HTMLElement>(
        "input, textarea, select, button:not([disabled]), [href]",
      );
    focusable?.focus();
  }, []);

  return (
    <div className="portal-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={`portal-modal${wide ? " portal-modal-wide" : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button aria-label="关闭" onClick={onClose} type="button">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}
