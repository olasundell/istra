import { useEffect, useId, useRef, type PropsWithChildren, type ReactNode } from "react";
import { Icon } from "./Icon";

interface OverlayProps extends PropsWithChildren {
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  variant?: "dialog" | "drawer";
  wide?: boolean;
}

export function Overlay({ title, description, onClose, footer, variant = "dialog", wide, children }: OverlayProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className={`overlay overlay--${variant}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`overlay__panel${wide ? " overlay__panel--wide" : ""}`}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="overlay__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button aria-label="Close" className="icon-button" onClick={onClose} type="button">
            <Icon name="close" />
          </button>
        </header>
        <div className="overlay__body">{children}</div>
        {footer ? <footer className="overlay__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

interface FieldProps extends PropsWithChildren {
  label: string;
  hint?: string;
  htmlFor?: string;
}

export function Field({ label, hint, htmlFor, children }: FieldProps) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function ErrorNotice({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="notice notice--error" role="alert">
      <div>
        <strong>We couldn’t load this view.</strong>
        <p>{error.message}</p>
      </div>
      {onRetry ? <button className="button button--secondary" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return (
    <div className="empty-state">
      <Icon name="note" size={28} />
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

