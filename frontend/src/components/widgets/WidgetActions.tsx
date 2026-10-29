/** Akcje w nagłówku widgetu: pełny ekran (daje go siatka pulpitu przez kontekst) i dodatkowe, np. eksport wykresu. */
import { IconDots, IconMaximize, type Icon } from "@tabler/icons-react";
import { createContext, useContext, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { useDismiss } from "../../lib/useDismiss";

/** Otwiera widget na pełnym ekranie; null – poza pulpitem albo już na pełnym ekranie. */
export const WidgetExpandContext = createContext<(() => void) | null>(null);

export interface WidgetAction {
  label: string;
  icon: Icon;
  onClick: () => void;
}

const buttonClass = "flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text";

/** Jedna akcja – zwykły przycisk z ikoną; kilka – menu „⋯”. Menu jest w portalu: komórka siatki przewija
 * i przycina treść, a przesunięte (transform) komórki psują pozycję `fixed`. */
export function WidgetActions({ actions = [] }: { actions?: WidgetAction[] }) {
  const expand = useContext(WidgetExpandContext);
  const all = expand ? [{ label: t("widget.fullscreen"), icon: IconMaximize, onClick: expand }, ...actions] : actions;
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(pos !== null, () => setPos(null), menu, trigger);

  if (all.length === 0) return null;
  if (all.length === 1) {
    const [only] = all;
    return (
      <button type="button" aria-label={only.label} title={only.label} onClick={only.onClick} className={buttonClass}>
        <only.icon size={16} aria-hidden="true" />
      </button>
    );
  }
  const toggle = () => {
    if (pos) return setPos(null);
    const r = trigger.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        aria-label={t("widget.actions")}
        title={t("widget.actions")}
        // Bez tego kliknięcie w przycisk przy otwartym menu najpierw je zamyka (klik „poza” menu), a potem otwiera
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
        className={buttonClass}
      >
        <IconDots size={16} aria-hidden="true" />
      </button>
      {pos &&
        createPortal(
          <div ref={menu} role="menu" aria-label={t("widget.actions")} style={pos} className="fixed z-50 w-48 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg">
            {all.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setPos(null);
                  a.onClick();
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <a.icon size={16} aria-hidden="true" className="text-text-2" />
                {a.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
