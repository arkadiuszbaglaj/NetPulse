import { describe, expect, it } from "vitest";
import { buildLines, seriesName } from "../components/charts/panelData";
import { bucketSeconds } from "../components/widgets/chartSource";
import { t } from "../i18n";
import { METRICS, SOURCE_METRICS, defaultSeries, newChartConfig, unitClassOf } from "../lib/layout";
import { sourceModule } from "../lib/modules";
import { WIDGET_TEMPLATES } from "../lib/widgetTemplates";
import { DEVICE } from "../test/mockApi";

const PORT = { id: 5, if_index: 5, name: "eth4", label: "WAN", alias: null, role: "wan", hidden: false, mac: null, admin_up: true, oper_status: "up", speed_mbps: 1000, in_bps: 1, out_bps: 1 };

describe("szczyt ruchu WAN (od 0.70.0)", () => {
  it("jest serią źródeł Ruch WAN i Port, w tej samej jednostce co średnia", () => {
    for (const kind of ["wan", "interface"] as const) {
      expect(SOURCE_METRICS[kind]).toEqual(expect.arrayContaining(["in_bps_max", "out_bps_max"]));
    }
    expect(unitClassOf("in_bps_max")).toBe("rate");
    expect(unitClassOf("out_bps_max")).toBe(unitClassOf("out_bps"));
    // Domyślny wykres zostaje bez szczytu – dokłada go opcja szablonu albo edytor
    expect(defaultSeries("wan").map((s) => s.key)).toEqual(["in_bps", "out_bps"]);
  });

  it("nazwy serii na wykresie WAN mówią o pobieraniu i wysyłaniu", () => {
    expect(seriesName({ kind: "wan" }, { key: "in_bps_max", color: 4 })).toBe("Pobieranie – szczyt");
    expect(seriesName({ kind: "wan" }, { key: "out_bps_max", color: 3 })).toBe("Wysyłanie – szczyt");
    expect(seriesName({ kind: "interface", id: 5, device_id: 1 }, { key: "in_bps_max", color: 4 })).toBe("Odbierane – szczyt (5 s)");
  });

  it("od 0.71.0 szablon Ruch WAN nie dokłada osobnej linii szczytu – szczyt jest w dymku", () => {
    const tpl = WIDGET_TEMPLATES.find((x) => x.id === "wan_traffic")!;
    expect(tpl.options).toEqual(["compare"]);
    const w = tpl.build({});
    if (w.type !== "chart") throw new Error("szablon nie zbudował wykresu");
    expect(w.config.queries[0].series.map((s) => s.key)).toEqual(["in_bps", "out_bps"]);
  });

  it("szczyt kubełka trafia do serii średniej (dymek „· maks.”), także bez serii szczytu na wykresie", () => {
    const config = newChartConfig({ kind: "wan" }, [{ key: "in_bps", color: 1 }, { key: "out_bps", color: 2 }]);
    const data = new Map([["A", { interval_s: 300, points: [
      { time: "2026-11-12T19:05:00Z", values: { in_bps: 26.2e6, out_bps: 3.5e6, in_bps_max: 455e6, out_bps_max: 51e6 } },
      { time: "2026-11-12T19:10:00Z", values: { in_bps: 0.5e6, out_bps: 0.1e6, in_bps_max: null, out_bps_max: null } },
    ] }]]);
    const [down, up] = buildLines(config, data, () => "");
    expect(down.peaks?.get(Date.parse("2026-11-12T19:05:00Z"))).toBe(455e6);
    expect(down.peaks?.has(Date.parse("2026-11-12T19:10:00Z"))).toBe(false);
    expect(up.peaks?.get(Date.parse("2026-11-12T19:05:00Z"))).toBe(51e6);
    expect(t("chart.withPeak", { value: "26 Mb/s", peak: "455 Mb/s" })).toBe("26 Mb/s · maks. 455 Mb/s");
  });

  it("kubełki wykresu jak w UniFi: 24 h po 5 min, 7 dni po godzinie", () => {
    expect(bucketSeconds(60)).toBe(30);
    expect(bucketSeconds(1440)).toBe(300);
    expect(bucketSeconds(10080)).toBe(3600);
  });
});

describe("testy prędkości bramy (od 0.70.0)", () => {
  it("źródło wykresu z modułu UniFi: pobieranie, wysyłanie i ping", () => {
    expect(SOURCE_METRICS.speedtest).toEqual(["down_bps", "up_bps", "ping_ms"]);
    expect(METRICS.ping_ms.unitClass).toBe("ms");
    expect(sourceModule("speedtest")).toBe("unifi");
    expect(defaultSeries("speedtest").map((s) => s.key)).toEqual(["down_bps", "up_bps"]);
  });

  it("szablon buduje wykres słupkowy dla wybranego łącza bramy, z zakresem 7 dni", () => {
    const tpl = WIDGET_TEMPLATES.find((x) => x.id === "speedtest")!;
    expect(tpl.fits?.({ ...DEVICE, kind: "gateway" })).toBe(true);
    expect(tpl.fits?.({ ...DEVICE, kind: "switch" })).toBe(false);
    const w = tpl.build({ device: { ...DEVICE, id: 1, kind: "gateway" }, port: PORT });
    if (w.type !== "chart") throw new Error("szablon nie zbudował wykresu");
    expect(w.config.queries[0].source).toEqual({ kind: "speedtest", id: 1, key: "eth4" });
    expect(w.config.chart).toBe("bar");
    expect(w.config.range_min).toBe(10080);
    expect(w.config.title).toBe("Testy prędkości – WAN");
  });
});
