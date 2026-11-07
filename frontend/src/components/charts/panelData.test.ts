import { describe, expect, it } from "vitest";
import { backupSpans, escapeHtml, tooltipHtml } from "./panelData";

describe("backupSpans – kiedy internet szedł łączem zapasowym", () => {
  const links = [
    { id: 5, position: 1 },
    { id: 9, position: 2 },
  ];
  const seg = (link_id: number, state: string, start: string, end: string) => ({ link_id, state, start, end });
  const ms = (s: string) => new Date(s).getTime();

  it("odcinki aktywne łącza zapasowego, połączone gdy na siebie zachodzą", () => {
    const segments = [
      seg(5, "active", "2026-11-04T03:00:00Z", "2026-11-04T03:34:21Z"),
      seg(5, "down", "2026-11-04T03:34:21Z", "2026-11-04T03:36:51Z"),
      seg(9, "standby", "2026-11-04T03:00:00Z", "2026-11-04T03:34:21Z"),
      seg(9, "active", "2026-11-04T03:34:21Z", "2026-11-04T03:35:30Z"),
      seg(9, "active", "2026-11-04T03:35:30Z", "2026-11-04T03:36:51Z"),
      seg(9, "active", "2026-11-04T05:00:00Z", "2026-11-04T05:00:00Z"), // zerowy odcinek – pomijamy
    ];
    expect(backupSpans({ links, segments })).toEqual([[ms("2026-11-04T03:34:21Z"), ms("2026-11-04T03:36:51Z")]]);
  });

  it("bez historii albo z jednym łączem – nic", () => {
    expect(backupSpans(undefined)).toEqual([]);
    expect(backupSpans({ links: [links[0]], segments: [seg(5, "active", "2026-11-04T03:00:00Z", "2026-11-04T04:00:00Z")] })).toEqual([]);
  });
});

describe("tooltipHtml – dymek wykresu bez wstrzykiwania HTML-a", () => {
  it("nazwa serii z kontenera albo maszyny jest tekstem, nie znacznikiem", () => {
    const html = tooltipHtml("12:00", "#000", [{ marker: "<span class=m></span>", name: '<img src=x onerror="alert(1)">', value: "5 Mb/s" }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("<span class=m></span> "); // znacznik koloru z ECharts zostaje
    expect(html).toContain("<b>5 Mb/s</b>");
  });

  it("escapeHtml zamienia wszystkie znaki specjalne", () => {
    expect(escapeHtml(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&#39;");
  });
});
