/**
 * Wspólny kursor wykresów: najechanie na jeden wykres pokazuje podpowiedź w tej samej chwili na pozostałych.
 * Po czasie, nie po pikselach – wykresy mają różne szerokości, osie i zakresy (echarts.connect przenosi piksele).
 */
import type * as echarts from "echarts/core";

const charts = new Set<echarts.ECharts>();
let syncing = false;
let last: number | null = null;

interface AxisPointerEvent {
  axesInfo?: { axisDim: string; value: number }[];
}

function showAt(chart: echarts.ECharts, time: number) {
  const x = chart.convertToPixel({ xAxisIndex: 0 }, time) as number;
  const y = chart.getHeight() / 2;
  chart.dispatchAction(Number.isFinite(x) && chart.containPixel("grid", [x, y]) ? { type: "showTip", x, y } : { type: "hideTip" });
}

/** Dołącza wykres do wspólnego kursora; zwraca funkcję odłączającą. */
export function linkChart(chart: echarts.ECharts): () => void {
  charts.add(chart);
  chart.on("updateAxisPointer", (e) => {
    const time = (e as AxisPointerEvent).axesInfo?.find((a) => a.axisDim === "x")?.value;
    if (syncing || time == null || time === last) return;
    last = time;
    syncing = true;
    try {
      for (const other of charts) if (other !== chart && !other.isDisposed()) showAt(other, time);
    } finally {
      syncing = false;
    }
  });
  chart.getZr().on("globalout", () => {
    last = null;
    for (const other of charts) if (other !== chart && !other.isDisposed()) other.dispatchAction({ type: "hideTip" });
  });
  return () => {
    charts.delete(chart);
  };
}
