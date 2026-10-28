import { useState } from "react";

export interface StateBarSegment {
  key: string;
  /** Położenie i szerokość w % szerokości pasa */
  left: number;
  width: number;
  /** Stan i czas, np. „działa: 25.10.2026, 11:00 – 11:30” */
  label: string;
  className: string;
}

/** Pas stanów na osi czasu. Odcinek pokazuje szczegóły po najechaniu (title), a po kliknięciu albo dotknięciu – pod
 * pasem, bo na telefonie podpowiedzi `title` nie ma. */
export function StateBar({ label, segments, className }: { label: string; segments: StateBarSegment[]; className: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const shown = segments.find((s) => s.key === picked);
  return (
    <div className="min-w-0 flex-1">
      <div role="list" aria-label={label} className={`relative overflow-hidden rounded bg-surface-2 ${className}`}>
        {segments.map((s) => (
          <span key={s.key} role="listitem" aria-label={s.label} title={s.label} className={`absolute inset-y-0 ${s.className}`} style={{ left: `${s.left}%`, width: `${s.width}%` }}>
            <button
              type="button"
              aria-label={s.label}
              aria-pressed={picked === s.key}
              onClick={() => setPicked((p) => (p === s.key ? null : s.key))}
              className="absolute inset-0 cursor-pointer focus-visible:ring-2 focus-visible:ring-text focus-visible:outline-none focus-visible:ring-inset"
            />
          </span>
        ))}
      </div>
      {shown && (
        <p role="status" className="mt-0.5 truncate text-text-2">
          {shown.label}
        </p>
      )}
    </div>
  );
}
