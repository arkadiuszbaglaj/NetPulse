import { describe, expect, it } from "vitest";
import { barClass, dayTitle, dailyBars, networkStatus, plural, recentAlerts, sortAlerts } from "../components/widgets/OverviewWidgets";
import { peakOf } from "../components/widgets/SummaryWidget";
import type { Alert } from "../lib/alerts";

describe("pasek stanu sieci", () => {
  const devices = { total: 5, up: 5, down: 0 };

  it("wszystko działa", () => {
    const s = networkStatus(devices, { critical: 0, warning: 0, info: 2 });
    expect(s.tone).toBe("success");
    expect(s.title).toBe("Sieć działa prawidłowo");
    expect(s.parts).toEqual(["5 z 5 urządzeń online"]);
  });

  it("ostrzeżenia nie psują stanu, ale są policzone", () => {
    const s = networkStatus(devices, { critical: 0, warning: 2, info: 0 });
    expect(s.tone).toBe("warning");
    expect(s.title).toBe("Sieć działa prawidłowo");
    expect(s.parts).toContain("2 ostrzeżenia");
  });

  it("urządzenie bez odpowiedzi i alerty krytyczne", () => {
    expect(networkStatus({ total: 5, up: 4, down: 1 }, null)).toMatchObject({ tone: "danger", title: "Nie odpowiada urządzeń: 1" });
    expect(networkStatus(devices, { critical: 1, warning: 0, info: 0 })).toMatchObject({ tone: "danger", parts: ["5 z 5 urządzeń online", "1 alert krytyczny"] });
  });

  it("bez urządzeń", () => {
    expect(networkStatus({ total: 0, up: 0, down: 0 }, null).title).toBe("Brak urządzeń do monitorowania");
  });

  it("odmiana liczebnika", () => {
    expect([1, 2, 4, 5, 12, 22, 25].map((n) => plural(n, "a", "b", "c"))).toEqual(["a", "b", "b", "c", "c", "b", "c"]);
  });
});

describe("paski dostępności", () => {
  it("średnia dnia, puste dni bez pomiarów, od najstarszego", () => {
    const now = new Date(2026, 10, 3, 12, 0);
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();
    const bars = dailyBars(
      [
        { time: at(3, 1), values: { availability_percent: 100 } },
        { time: at(3, 2), values: { availability_percent: 90 } },
        { time: at(1, 5), values: { availability_percent: 100 } },
        { time: at(1, 6), values: { availability_percent: null } },
      ],
      3,
      now,
    );
    expect(bars.map((b) => b.value)).toEqual([100, null, 95]);
    expect(bars.map((b) => b.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });
});

describe("kolor paska dostępności", () => {
  it("kolor ostrzeżenia tylko dla dni z prawdziwą awarią (od 0.66.0: poniżej 99 %), brak danych – tło", () => {
    expect(barClass(100)).toBe("bg-success");
    expect(barClass(99.95)).toBe("bg-success");
    expect(barClass(99.4)).toBe("bg-success"); // kilka zgubionych pingów to nie awaria
    expect(barClass(99)).toBe("bg-success");
    expect(barClass(98.9)).toBe("bg-warning");
    expect(barClass(95)).toBe("bg-warning");
    expect(barClass(80)).toBe("bg-danger");
    expect(barClass(null)).toBe("bg-surface-2");
  });

  it("dymek dnia podaje przybliżony czas przerwy", () => {
    expect(dayTitle({ day: "2026-11-01", value: 100 })).toBe("2026-11-01: 100 %");
    expect(dayTitle({ day: "2026-11-02", value: 99 })).toBe("2026-11-02: 99 % (ok. 14 min przerwy)");
    expect(dayTitle({ day: "2026-11-03", value: 90 })).toBe("2026-11-03: 90 % (ok. 2 h 24 min przerwy)");
    expect(dayTitle({ day: "2026-11-04", value: null })).toBe("2026-11-04: brak pomiarów");
  });
});

describe("alerty i szczyty", () => {
  it("aktywne na górze, potem najnowsze", () => {
    const a = (id: number, state: Alert["state"], started_at: string) => ({ id, state, started_at }) as Alert;
    const sorted = sortAlerts([a(1, "resolved", "2026-11-03T10:00:00Z"), a(2, "firing", "2026-11-01T10:00:00Z"), a(3, "resolved", "2026-11-03T12:00:00Z")]);
    expect(sorted.map((x) => x.id)).toEqual([2, 3, 1]);
  });

  it("starsze aktywne nie giną za świeżo rozwiązanymi", () => {
    const a = (id: number, state: Alert["state"], started_at: string) => ({ id, state, started_at }) as Alert;
    const firing = [a(1, "firing", "2026-10-29T16:00:00Z"), a(2, "firing", "2026-10-28T02:00:00Z")];
    const resolved = [5, 6, 7].map((id) => a(id, "resolved", `2026-11-0${id - 4}T10:00:00Z`));
    expect(recentAlerts(firing, resolved, 3).map((x) => x.id)).toEqual([1, 2, 7]);
  });

  it("szczyt serii pomija puste punkty", () => {
    const peak = peakOf(
      [
        { time: "t1", values: { in_bps: 5 } },
        { time: "t2", values: { in_bps: null } },
        { time: "t3", values: { in_bps: 9 } },
      ],
      "in_bps",
    );
    expect(peak).toEqual({ value: 9, time: "t3" });
    expect(peakOf([], "in_bps")).toBeNull();
  });
});
