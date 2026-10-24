const rtf = new Intl.RelativeTimeFormat("pl", { numeric: "auto" });

/** „12 s temu”, „5 min temu”, „wczoraj”. `now` do testów. */
export function relativeTime(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const diffS = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffS);
  if (abs < 5) return "przed chwilą";
  if (abs < 60) return rtf.format(diffS, "second");
  if (abs < 3600) return rtf.format(Math.round(diffS / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffS / 3600), "hour");
  return rtf.format(Math.round(diffS / 86400), "day");
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("pl", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso));
}

export function formatUptime(seconds: number | null): string {
  if (seconds == null) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/** Prędkość w bitach na sekundę → „42,3 Mb/s”. `null` → „–”. */
export function formatBps(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "–";
  const units = ["b/s", "kb/s", "Mb/s", "Gb/s"];
  let v = Math.abs(bps);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat("pl", { maximumFractionDigits: digits }).format(v)} ${units[i]}`;
}

/** Etykieta zakresu czasu: 15 → „15 min”, 60 → „1 godz.”, 1440 → „24 godz.”, 10080 → „7 dni”. */
export function formatRange(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${minutes / 60} godz.`;
  if (minutes === 1440) return "24 godz.";
  return `${minutes / 1440} dni`;
}

export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}
