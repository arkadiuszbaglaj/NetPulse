/**
 * Swobodna siatka pulpitu (od 0.28.0): 12 kolumn, wiersz 30 px. Od 720 px szerokości siatki (do 0.53.0: od 1024 px) –
 * react-grid-layout z przeciąganiem i rozciąganiem w trybie edycji, na laptopie te same położenia co na dużym ekranie,
 * tylko węższe kolumny; węziej widgety w kolejności czytania: od 640 px w dwóch kolumnach (pary z tego samego rzędu
 * siatki, wspólna wysokość pary; szerokie i bez pary na całą), na telefonie jeden pod drugim. Tam w trybie edycji przestawia się je przyciskami w górę i w dół. Sekcje zwijają widgety
 * pod sobą (stan zwinięcia pamięta przeglądarka, osobno dla każdego pulpitu). Od 0.56.0 widgety z listą (`AUTO_HEIGHT`)
 * w podglądzie wydłużają się, gdy treść się nie mieści (widgety pod nimi schodzą niżej), a w trybie edycji dostają
 * przycisk „Dopasuj wysokość”, który zapisuje potrzebną wysokość w układzie.
 */
import { IconArrowAutofitHeight, IconChevronDown, IconChevronRight, IconX } from "@tabler/icons-react";
import { createContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { t } from "../i18n";
import { WidgetExpandContext } from "./widgets/WidgetActions";
import {
  AUTO_HEIGHT,
  GRID_COLS,
  GRID_MARGIN,
  MAX_HEIGHT,
  ROW_HEIGHT,
  hiddenBySections,
  placeWidgets,
  pushDown,
  readingOrder,
  rowsFor,
  rowsToPx,
  type GridBox,
  type Widget,
} from "../lib/layout";

/** Widget w komórce siatki o stałej wysokości: wykresy wypełniają całą komórkę. */
export const GridCellContext = createContext(false);

/** Komórka z kontenerem zapytań (od 0.53.0): `np-fit` = stała wysokość (siatka, pełny ekran, wykres na telefonie) –
 * treść widgetu skaluje się do rozmiaru karty (`index.css`, „Dopasowanie treści”); bez niej – tylko do szerokości. */
const cellClass = (fit: boolean) => `np-cell ${fit ? "np-fit" : ""}`;

/** Od tej szerokości siatki – swobodna siatka (laptop: siatka bez menu ma 780–960 px) */
const DESKTOP = 720;
const TABLET = 640;
/** Na telefonie te widgety mają wysokość z siatki (wykres potrzebuje wysokości), reszta – swoją. */
const FIXED_ON_MOBILE = new Set<Widget["type"]>(["chart", "stat", "wan_chart"]);
/** W dwóch kolumnach widget od tej szerokości (z 12) zajmuje całą szerokość. */
const WIDE = 8;
/** Zmiana szerokości siatki, od której wydłużenie kart liczy się od nowa (większa niż pasek przewijania strony). */
const RESET_WIDTH = 40;

/** Dwa widgety w tym samym rzędzie siatki (zachodzą na siebie w pionie); bez położeń – zawsze. */
function sameRow(a: Widget, b: Widget): boolean {
  if (a.y == null || b.y == null) return true;
  return a.y < b.y + (b.h ?? 1) && b.y < a.y + (a.h ?? 1);
}

/** Układ dwóch kolumn: pary wąskich sąsiadów z tego samego rzędu siatki (od 0.54.0 – wcześniej kolejne w kolejności
 * czytania, więc widget z jednego rzędu łączył się z widgetem z następnego); szerokie, sekcje i bez pary – na całą szerokość. */
export function pairsInColumns(ordered: Widget[]): { full: Set<string>; partner: Map<string, Widget> } {
  const wide = (w: Widget | undefined) => !w || w.type === "section" || w.w >= WIDE;
  const full = new Set<string>();
  const partner = new Map<string, Widget>();
  for (let i = 0; i < ordered.length; i++) {
    const w = ordered[i]!;
    const next = ordered[i + 1];
    if (wide(w) || wide(next) || !sameRow(w, next!)) {
      full.add(w.id);
      continue;
    }
    partner.set(w.id, next!);
    partner.set(next!.id, w);
    i++;
  }
  return { full, partner };
}

/** Widgety na całą szerokość w dwóch kolumnach (zob. `pairsInColumns`). */
export function fullWidthInColumns(ordered: Widget[]): Set<string> {
  return pairsInColumns(ordered).full;
}

/** Gdzie jest widget w trybie edycji: w siatce (przeciąganie) albo w kolejności czytania (przyciski w górę i w dół). */
export interface EditPlace {
  stacked: boolean;
  first: boolean;
  last: boolean;
}

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
        <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="flex items-center gap-1.5 rounded-md text-base font-semibold hover:text-accent-text">
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

/** Komórka, która zgłasza wysokość swojej treści (`scrollHeight` – nie mniej niż wysokość komórki) przy zmianie
 * rozmiaru i treści (nowe dane, ładowanie, zwijanie wierszy). Zgłoszenie raz na klatkę. */
function OverflowWatch({ onOverflow, className, children }: { onOverflow: (contentPx: number) => void; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const report = useRef(onOverflow);
  report.current = onOverflow;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => report.current(el.scrollHeight));
    };
    const resize = new ResizeObserver(check);
    resize.observe(el);
    for (const child of Array.from(el.children)) resize.observe(child);
    const mutation = new MutationObserver(check);
    mutation.observe(el, { childList: true, subtree: true, characterData: true });
    check();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** Widget na pełnym ekranie: nad całym panelem, Escape albo przycisk zamyka, fokus wraca na miejsce. */
function Fullscreen({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  // Funkcja zamykania z rodzica jest nowa przy każdym renderze – efekt (fokus, Escape) tylko raz, przy otwarciu
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      back?.focus();
    };
  }, []);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-50 flex flex-col gap-2 bg-bg p-3 sm:p-4">
      <div className="flex shrink-0 justify-end">
        <button
          ref={close}
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text-2 hover:text-text"
        >
          <IconX size={16} aria-hidden="true" />
          {t("widget.fullscreen.close")}
        </button>
      </div>
      <div className={`${cellClass(true)} flex min-h-0 flex-1 flex-col *:flex-1`}>
        <GridCellContext.Provider value>{children}</GridCellContext.Provider>
      </div>
    </div>,
    document.body,
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
  renderEditBar?: (w: Widget, place: EditPlace) => ReactNode;
  /** Nazwa widgetu dla okna pełnego ekranu */
  widgetLabel?: (w: Widget) => string;
}

export function DashboardGrid({ widgets, scope, edit = false, onPositions, renderWidget, renderEditBar, widgetLabel }: DashboardGridProps) {
  // Siatka dopiero po zmierzeniu kontenera – inaczej wąski ekran mignąłby układem desktopowym i widgety montowałyby się dwa razy
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const [overrides, setOverrides] = useState(() => readOverrides(scope));
  const [expanded, setExpanded] = useState<string | null>(null);
  const all = useMemo(() => placeWidgets(widgets), [widgets]);
  const collapsed = useMemo(
    () => new Set(all.filter((w) => w.type === "section" && (overrides[w.id] ?? w.config.collapsed)).map((w) => w.id)),
    [all, overrides],
  );
  const hidden = useMemo(() => (edit ? new Set<string>() : hiddenBySections(all, collapsed)), [all, collapsed, edit]);
  const visible = all.filter((w) => !hidden.has(w.id));

  // Wydłużenie kart w podglądzie (wiersze siatki ponad zapisane `h`) i brakujące wiersze w trybie edycji.
  // Po zmianie szerokości albo układu liczone od nowa – wtedy karta może też wrócić do zapisanej wysokości.
  const [grow, setGrow] = useState<Record<string, number>>({});
  const [need, setNeed] = useState<Record<string, number>>({});
  // Szerokość tylko przy wyraźnej zmianie: wydłużona strona dostaje pasek przewijania (siatka węższa o ~15 px),
  // a liczenie od nowa skróciłoby ją z powrotem – i tak w kółko.
  const shape = widgets.map((w) => `${w.id}:${w.x}:${w.y}:${w.w}:${w.h}`).join(",");
  const counted = useRef({ width, shape, edit });
  useEffect(() => {
    const c = counted.current;
    if (Math.abs(width - c.width) <= RESET_WIDTH && shape === c.shape && edit === c.edit) return;
    counted.current = { width, shape, edit };
    // Wydłużone karty wracają do zapisanej wysokości i mierzą się na nowo (zmiana rozmiaru = nowy pomiar). `need` się
    // nie czyści: karta, której rozmiar się nie zmienił, nie zgłosi się ponownie, a jej pomiar jest dalej aktualny.
    setGrow({});
  }, [width, shape, edit]);
  const report = (w: Widget, contentPx: number) => {
    const rows = Math.max(0, Math.min(MAX_HEIGHT, rowsFor(contentPx)) - (w.h ?? 1));
    if (edit) setNeed((n) => ((n[w.id] ?? 0) === rows ? n : { ...n, [w.id]: rows }));
    // Tylko w górę: treść rozciągnięta na całą kartę ma wysokość karty, więc mniejszy pomiar to stan w trakcie animacji
    else setGrow((g) => (rows > (g[w.id] ?? 0) ? { ...g, [w.id]: rows } : g));
  };

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

  const desktop = width >= DESKTOP;
  const ordered = desktop ? visible : readingOrder(visible);
  const placeOf = (w: Widget): EditPlace => {
    const i = ordered.indexOf(w);
    return { stacked: !desktop, first: i === 0, last: i === ordered.length - 1 };
  };

  const fixedHeight = (w: Widget) => desktop || FIXED_ON_MOBILE.has(w.type);
  const box = (w: Widget, extra = 0): GridBox => ({ i: w.id, x: w.x ?? 0, y: w.y ?? 0, w: w.w, h: Math.min(MAX_HEIGHT, (w.h ?? 1) + extra) });
  // Podgląd: karty wydłużone o `grow`, reszta zsunięta niżej; edycja: dokładnie zapisany układ
  const boxes = edit ? visible.map((w) => box(w)) : pushDown(visible.map((w) => box(w, grow[w.id] ?? 0)));
  const fit = (w: Widget) => onPositions?.(pushDown(visible.map((x) => box(x, x.id === w.id ? (need[w.id] ?? 0) : 0))));
  const content = (w: Widget) => (
    <WidgetExpandContext.Provider value={edit ? null : () => setExpanded(w.id)}>
      <GridCellContext.Provider value>{renderWidget(w)}</GridCellContext.Provider>
    </WidgetExpandContext.Provider>
  );
  const cell = (w: Widget) => {
    if (w.type === "section") {
      const count = edit ? 0 : hiddenBySections(all, new Set([w.id])).size;
      return (
        <div className="relative flex h-full flex-col">
          {edit && <div className="absolute bottom-1 right-0 z-20">{renderEditBar?.(w, placeOf(w))}</div>}
          <SectionHeader title={w.config.title} collapsed={!edit && collapsed.has(w.id)} onToggle={edit ? undefined : () => toggle(w.id)} hiddenCount={count} />
        </div>
      );
    }
    return (
      // W trybie edycji pasek narzędzi leży nad kartą (w rogu), a nie w niej – widget ma tę samą wysokość co w podglądzie
      <div className={`relative flex h-full min-h-0 flex-col ${edit ? "rounded-2xl outline-2 outline-offset-2 outline-dashed outline-border-strong" : ""}`}>
        {edit && <div className="absolute right-2 top-2 z-20">{renderEditBar?.(w, placeOf(w))}</div>}
        {edit && desktop && (need[w.id] ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => fit(w)}
            title={t("widget.fit.hint")}
            className="absolute bottom-2 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-2.5 py-1 text-xs font-medium shadow-sm hover:text-accent-text"
          >
            <IconArrowAutofitHeight size={14} aria-hidden="true" />
            {t("widget.fit", { n: need[w.id] ?? 0 })}
          </button>
        )}
        {desktop && AUTO_HEIGHT.has(w.type) ? (
          <OverflowWatch onOverflow={(px) => report(w, px)} className={`${cellClass(true)} flex min-h-0 flex-1 flex-col overflow-auto *:flex-1`}>
            {content(w)}
          </OverflowWatch>
        ) : (
          <div className={`${cellClass(fixedHeight(w))} flex min-h-0 flex-1 flex-col overflow-auto *:flex-1`}>{content(w)}</div>
        )}
      </div>
    );
  };

  const columns = width >= TABLET;
  const big = expanded && !edit ? all.find((w) => w.id === expanded) : undefined;
  const { full, partner } = columns ? pairsInColumns(ordered) : { full: new Set<string>(), partner: new Map<string, Widget>() };
  /** Wysokość w trybie kolejności czytania: sekcja – nagłówek; wykres i liczba – z siatki. W dwóch kolumnach para ma wspólną
   * wysokość (rząd siatki rozciąga obie karty), więc tam wysokość z siatki jest minimum, a nie sztywną wysokością. */
  const stackedStyle = (w: Widget): CSSProperties | undefined => {
    if (w.type === "section") return { height: rowsToPx(1) + 8 };
    const other = partner.get(w.id);
    const fixed = [w, other].filter((x): x is Widget => !!x && FIXED_ON_MOBILE.has(x.type));
    if (!fixed.length) return undefined;
    const px = rowsToPx(Math.max(...fixed.map((x) => x.h ?? 8)));
    return other ? { minHeight: px } : { height: px };
  };
  return (
    <div ref={containerRef} className="np-grid min-w-0">
      {big && (
        <Fullscreen label={widgetLabel?.(big) ?? t("widget.fullscreen")} onClose={() => setExpanded(null)}>
          {renderWidget(big)}
        </Fullscreen>
      )}
      {!mounted ? null : desktop ? (
        <ReactGridLayout
          width={width}
          layout={boxes.map((b, n) => ({
            ...b,
            maxH: MAX_HEIGHT,
            isResizable: edit && visible[n]!.type !== "section",
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
        <div className={columns ? "grid grid-cols-2 gap-3" : "flex flex-col gap-3"}>
          {ordered.map((w) => (
            <div key={w.id} className={`min-w-0 ${full.has(w.id) ? "col-span-2" : ""}`} style={stackedStyle(w)}>
              {cell(w)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
