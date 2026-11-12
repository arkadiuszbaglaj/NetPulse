import { describe, expect, it } from "vitest";
import { seriesName } from "../components/charts/panelData";
import { METRICS, SOURCE_METRICS, defaultSeries, unitClassOf } from "../lib/layout";
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

  it("szablon Ruch WAN z opcją szczytu dokłada dwie serie i rysuje linie", () => {
    const tpl = WIDGET_TEMPLATES.find((x) => x.id === "wan_traffic")!;
    expect(tpl.options).toContain("peak");
    const plain = tpl.build({});
    const peak = tpl.build({ options: { peak: true } });
    if (plain.type !== "chart" || peak.type !== "chart") throw new Error("szablon nie zbudował wykresu");
    expect(plain.config.queries[0].series.map((s) => s.key)).toEqual(["in_bps", "out_bps"]);
    expect(peak.config.queries[0].series.map((s) => s.key)).toEqual(["in_bps", "out_bps", "in_bps_max", "out_bps_max"]);
    expect(peak.config.chart).toBe("line");
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
