/** Miniatura szablonu w oknie „Dodaj widget” (0.44.0): sam kształt widgetu w kolorach motywu, bez danych. */
import type { ThumbKind } from "../../lib/widgetTemplates";

const C1 = "var(--chart-1)";
const C8 = "var(--chart-8)";
const OPACITY = [0.15, 0.3, 0.55, 0.85, 0.25, 0.1, 0.4, 0.7, 0.2, 0.5, 0.9, 0.35];

function Line({ threshold }: { threshold?: boolean }) {
  return (
    <svg viewBox="0 0 200 60" preserveAspectRatio="none" className="h-full w-full">
      {threshold && <line x1="0" y1="14" x2="200" y2="14" stroke="var(--chart-4)" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
      {!threshold && <path d="M0 60 L0 40 L20 36 L40 42 L60 30 L80 34 L100 18 L120 26 L140 14 L160 22 L180 10 L200 16 L200 60 Z" fill={C1} fillOpacity={0.1} />}
      <polyline
        points={threshold ? "0,44 20,42 40,45 60,40 80,43 100,10 120,42 140,44 160,41 180,8 200,43" : "0,40 20,36 40,42 60,30 80,34 100,18 120,26 140,14 160,22 180,10 200,16"}
        fill="none"
        stroke={C1}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      <polyline points="0,54 20,52 40,53 60,50 80,51 100,47 120,49 140,46 160,48 180,45 200,47" fill="none" stroke={C8} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Rows({ bars }: { bars?: boolean }) {
  const widths = [82, 54, 33, 12];
  const dots = ["bg-success", "bg-success", "bg-warning", "bg-border-strong"];
  return (
    <div className="flex w-full flex-col gap-1.5">
      {widths.map((w, i) => (
        <div key={w} className="flex items-center gap-1.5">
          {bars ? (
            <>
              <span className="h-1 w-8 rounded-full bg-border-strong" />
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                <span className="block h-full rounded-full" style={{ width: `${w}%`, background: C1 }} />
              </span>
            </>
          ) : (
            <>
              <span className={`size-1.5 rounded-full ${dots[i]}`} />
              <span className="h-1 flex-[2] rounded-full bg-border-strong" />
              <span className="h-1 flex-1 rounded-full bg-border" />
              <span className="h-1 flex-1 rounded-full bg-border" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function WidgetThumb({ kind, height = 88 }: { kind: ThumbKind; height?: number }) {
  return (
    <div aria-hidden="true" className="flex w-full items-end overflow-hidden rounded-lg bg-surface-2 px-3 py-2.5" style={{ height }}>
      {(kind === "line" || kind === "lineth") && <Line threshold={kind === "lineth"} />}
      {kind === "bars" && <Rows bars />}
      {(kind === "table" || kind === "list") && <Rows />}
      {kind === "gauge" && (
        <svg viewBox="0 0 100 54" className="mx-auto h-full">
          <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="var(--border)" strokeWidth={9} strokeLinecap="round" />
          <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke={C1} strokeWidth={9} strokeLinecap="round" strokeDasharray="58 126" />
        </svg>
      )}
      {kind === "heat" && (
        <div className="grid w-full grid-cols-12 gap-0.5">
          {Array.from({ length: 36 }, (_, i) => (
            <span key={i} className="h-2 rounded-sm" style={{ background: C1, opacity: OPACITY[(i * 7) % 12] }} />
          ))}
        </div>
      )}
      {kind === "stat" && (
        <div className="flex w-full flex-col gap-0.5">
          <span className="text-lg font-semibold leading-none tracking-tight">
            18 <span className="text-[11px] font-normal text-muted">ms</span>
          </span>
          <svg viewBox="0 0 200 24" preserveAspectRatio="none" className="h-5 w-full">
            <polyline points="0,18 25,16 50,17 75,12 100,15 125,6 150,14 175,11 200,13" fill="none" stroke={C1} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}
      {kind === "status" && (
        <div className="flex w-full items-center gap-2 rounded-md bg-surface p-2">
          <span className="size-4 shrink-0 rounded-full bg-success-soft ring-2 ring-success/40" />
          <span className="flex flex-1 flex-col gap-1">
            <span className="h-1.5 w-3/4 rounded-full bg-border-strong" />
            <span className="h-1 w-11/12 rounded-full bg-border" />
          </span>
        </div>
      )}
      {kind === "timeline" && (
        <div className="flex w-full flex-col gap-1">
          {[
            [9, 0, 0],
            [5, 1, 4],
            [6, 3, 0],
            [3, 1, 6],
          ].map(([a, b, c], i) => (
            <div key={i} className="flex h-2 gap-0.5">
              <span className="rounded-sm bg-[var(--state-up)]" style={{ flex: a }} />
              {b > 0 && <span className={`rounded-sm ${i === 1 ? "bg-[var(--state-unknown)]" : "bg-[var(--state-down)]"}`} style={{ flex: b }} />}
              {c > 0 && <span className="rounded-sm bg-[var(--state-up)]" style={{ flex: c }} />}
            </div>
          ))}
        </div>
      )}
      {kind === "poe" && (
        <div className="grid w-full grid-cols-8 gap-1">
          {[1, 1, 0, 0, 0, 2, 2, 1].map((v, i) => (
            <span key={i} className="h-6 rounded-sm" style={{ background: v === 1 ? C1 : v === 2 ? "var(--state-up)" : "var(--border)" }} />
          ))}
        </div>
      )}
    </div>
  );
}
