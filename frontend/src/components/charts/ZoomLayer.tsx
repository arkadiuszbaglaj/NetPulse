import { IconZoomOut } from "@tabler/icons-react";
import type * as echarts from "echarts/core";
import { useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { t } from "../../i18n";
import { useRefresh } from "../../lib/refresh";

/** Najmniejsze zaznaczenie w pikselach – krótsze to zwykłe kliknięcie */
const MIN_DRAG = 6;

/**
 * Powiększanie zaznaczeniem: przeciągnięcie myszą po wykresie zawęża oś czasu wszystkich wykresów do zaznaczonego
 * fragmentu; „Wróć” (albo dwuklik) cofa o jedno powiększenie. Tylko mysz – na ekranie dotykowym przeciąganie
 * przewija stronę.
 */
export function ZoomLayer({ chart, height, children }: { chart: RefObject<echarts.ECharts | null>; height: number | string; children: ReactNode }) {
  const { zoom, canZoom, zoomTo, zoomOut } = useRefresh();
  const box = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);

  const point = (e: PointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!canZoom || e.pointerType !== "mouse" || e.button !== 0) return;
    const [x, y] = point(e);
    if (!chart.current?.containPixel("grid", [x, y])) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setSel({ start: x, end: x });
  };
  const onMove = (e: PointerEvent) => {
    if (sel) setSel({ ...sel, end: point(e)[0] });
  };
  const onUp = () => {
    if (sel && chart.current && Math.abs(sel.end - sel.start) >= MIN_DRAG) {
      const time = (px: number) => chart.current!.convertFromPixel({ xAxisIndex: 0 }, px) as number;
      const [from, to] = [time(Math.min(sel.start, sel.end)), Math.min(Date.now(), time(Math.max(sel.start, sel.end)))];
      zoomTo(from, to);
    }
    setSel(null);
  };

  return (
    <div
      ref={box}
      className={`relative ${canZoom ? "select-none" : ""}`}
      style={{ height }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setSel(null)}
      onDoubleClick={zoom ? zoomOut : undefined}
    >
      {children}
      {sel && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 border-x border-accent bg-accent/15"
          style={{ left: Math.min(sel.start, sel.end), width: Math.abs(sel.end - sel.start) }}
        />
      )}
      {zoom && canZoom && (
        <button
          type="button"
          onClick={zoomOut}
          aria-label={t("zoom.out")}
          title={t("zoom.out.hint")}
          className="absolute top-0 right-0 flex size-7 items-center justify-center rounded-md border border-border bg-surface/90 text-text-2 hover:text-text"
        >
          <IconZoomOut size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
