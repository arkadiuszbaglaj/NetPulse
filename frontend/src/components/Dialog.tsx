import { IconX } from "@tabler/icons-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { t } from "../i18n";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Przyciski na dole okna */
  footer?: ReactNode;
  /** Szerokość: sm (potwierdzenia) albo lg (formularze) */
  size?: "sm" | "lg";
}

/**
 * Okno modalne: Escape i kliknięcie w tło zamykają, Tab krąży po elementach okna,
 * a po zamknięciu fokus wraca tam, skąd okno otwarto. Renderuj warunkowo: `{open && <Dialog …/>}`.
 */
export function Dialog({ title, onClose, children, footer, size = "lg" }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const body = document.body;
    const overflow = body.style.overflow;
    body.style.overflow = "hidden";

    // Fokus na pierwszym polu formularza, a bez pól – na samym oknie
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea, [data-autofocus]");
    (first ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-full w-full flex-col rounded-t-2xl border border-border bg-surface shadow-xl outline-none sm:rounded-2xl ${
          size === "sm" ? "sm:max-w-md" : "sm:max-w-xl"
        }`}
      >
        <div className="grid grid-cols-[2rem_1fr_2rem] items-center gap-3 border-b border-border px-5 py-3">
          <span aria-hidden="true" />
          <h2 id={titleId} className="text-center text-base font-medium">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex size-8 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text"
          >
            <IconX size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
