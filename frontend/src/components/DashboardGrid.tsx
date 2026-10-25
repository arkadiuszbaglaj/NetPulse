/**
 * Swobodna siatka pulpitu (od 0.28.0): 12 kolumn, wiersz 30 px. Od 1024 px – react-grid-layout z przeciąganiem
 * i rozciąganiem w trybie edycji; węziej widgety jeden pod drugim w kolejności czytania. Sekcje zwijają widgety
 * pod sobą (stan zwinięcia pamięta przeglądarka, osobno dla każdego pulpitu).
 */
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { createContext, useMemo, useState, type ReactNode } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { t } from "../i18n";
import { GRID_COLS, GRID_MARGIN, MAX_HEIGHT, ROW_HEIGHT, hiddenBySections, placeWidgets, readingOrder, rowsToPx, type Widget } from "../lib/layout";

/** Widget w komórce siatki o stałej wysokości: wykresy wypełniają całą komórkę. */
export const GridCellContext = createContext(false);

const DESKTOP = 1024;
/** Na telefonie te widgety mają wysokość z siatki (wykres potrzebuje wysokości), reszta – swoją. */
const FIXED_ON_MOBILE = new Set<Widget["type"]>(["chart", "stat"]);

function storageKey(scope: string) {
  return `netpulse.sections.${scope}`;
}

/** Zwinięcia klikane przez oglądającego (id sekcji → zwinięta?); reszta sekcji – jak w konfiguracji. */
function readOverrides(scope: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, boolean>;
  } catch {
    // brak dostępu do localStorage (tryb prywatny) – domyślne z konfiguracji
  }
  return {};
}

export function SectionHeader({ title, collapsed, onToggle, hiddenCount }: { title: string; collapsed?: boolean; onToggle?: () => void; hiddenCount?: number }) {
  const Icon = collapsed ? IconChevronRight : IconChevronDown;
  return (
    <div className="flex h-full items-end border-b border-border pb-1">
      {onToggle ? (
        <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="flex items-center gap-1.5 rounded-md text-base font-semibold hover:text-accent">
          <Icon size={18} aria-hidden="true" />
          {title}
          {collapsed && hiddenCount ? <span className="text-xs font-normal text-text-2">{t("section.hidden", { n: hiddenCount })}</span> : null}
        </button>
      ) : (
        <h2 className="text-base font-semibold">{title}</h2>
      )}
    </div>
  );
}

export interface DashboardGridProps {
  widgets: Widget[];
  /** Klucz pamięci zwiniętych sekcji (np. id pulpitu) */
  scope: string;
  edit?: boolean;
  /** Pozycje po przeciągnięciu albo rozciągnięciu (tryb edycji) */
  onPositions?: (items: { i: string; x: number; y: number; w: number; h: number }[]) => void;
  renderWidget: (w: Widget) => ReactNode;
  /** Pasek narzędzi widgetu w trybie edycji (z uchwytem `.np-drag`) */
  renderEditBar?: (w: Widget) => ReactNode;
}

export function DashboardGrid({ widgets, scope, edit = false, onPositions, renderWidget, renderEditBar }: DashboardGridProps) {
  // Siatka dopiero po zmierzeniu kontenera – inaczej wąski ekran mignąłby układem desktopowym i widgety montowałyby się dwa razy
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const [overrides, setOverrides] = useState(() => readOverrides(scope));
  const all = useMemo(() => placeWidgets(widgets), [widgets]);
  const collapsed = useMemo(
    () => new Set(all.filter((w) => w.type === "section" && (overrides[w.id] ?? w.config.collapsed)).map((w) => w.id)),
    [all, overrides],
  );
  const hidden = useMemo(() => (edit ? new Set<string>() : hiddenBySections(all, collapsed)), [all, collapsed, edit]);
  const visible = all.filter((w) => !hidden.has(w.id));

  const toggle = (id: string) =>
    setOverrides((o) => {
      const next = { ...o, [id]: !collapsed.has(id) };
      try {
        localStorage.setItem(storageKey(scope), JSON.stringify(next));
      } catch {
        // stan zwinięcia tylko do zamknięcia strony
      }
      return next;
    });

  const cell = (w: Widget) => {
    if (w.type === "section") {
      const count = edit ? 0 : hiddenBySections(all, new Set([w.id])).size;
      return (
        <div className="flex h-full flex-col">
          {edit && renderEditBar?.(w)}
          <SectionHeader title={w.config.title} collapsed={!edit && collapsed.has(w.id)} onToggle={edit ? undefined : () => toggle(w.id)} hiddenCount={count} />
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        {edit && renderEditBar?.(w)}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto *:flex-1">
          <GridCellContext.Provider value>{renderWidget(w)}</GridCellContext.Provider>
        </div>
      </div>
    );
  };

  const desktop = width >= DESKTOP;
  return (
    <div ref={containerRef} className="np-grid min-w-0">
      {!mounted ? null : desktop ? (
        <ReactGridLayout
          width={width}
          layout={visible.map((w) => ({
            i: w.id,
            x: w.x ?? 0,
            y: w.y ?? 0,
            w: w.w,
            h: w.h ?? 1,
            maxH: MAX_HEIGHT,
            isResizable: edit && w.type !== "section",
            resizeHandles: ["se", "e", "s"],
          }))}
          gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [GRID_MARGIN, GRID_MARGIN], containerPadding: [0, 0] }}
          dragConfig={{ enabled: edit, handle: ".np-drag" }}
          resizeConfig={{ enabled: edit }}
          onDragStop={(layout) => onPositions?.([...layout])}
          onResizeStop={(layout) => onPositions?.([...layout])}
        >
          {visible.map((w) => (
            <div key={w.id} className="min-w-0">
              {cell(w)}
            </div>
          ))}
        </ReactGridLayout>
      ) : (
        <div className="flex flex-col gap-3">
          {readingOrder(visible).map((w) => (
            <div key={w.id} className="min-w-0" style={w.type === "section" ? { height: rowsToPx(1) + 8 } : FIXED_ON_MOBILE.has(w.type) ? { height: rowsToPx(w.h ?? 8) + (edit ? 44 : 0) } : undefined}>
              {cell(w)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
