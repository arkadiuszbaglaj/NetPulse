import { refreshLabel } from "../../components/RefreshControl";
import { Card, PageHeader, Select } from "../../components/ui";
import { t } from "../../i18n";
import { formatRange } from "../../lib/format";
import { useDashboardSummary } from "../../lib/queries";
import { RANGE_OPTIONS, REFRESH_OPTIONS, useRefresh, type RangeMinutes, type RefreshSeconds } from "../../lib/refresh";

/** Ustawienia → Odświeżanie: interwał automatycznego odświeżania i zakres czasu wykresów. */
export function RefreshPage() {
  const { refreshSeconds, setRefreshSeconds, rangeMinutes, setRangeMinutes } = useRefresh();
  const { data: summary } = useDashboardSummary();
  return (
    <>
      <PageHeader title={t("settings.refresh.title")} />
      <Card className="flex max-w-md flex-col gap-4 p-5">
        <p className="text-sm text-text-2">{t("settings.refresh.intro")}</p>
        <Select
          id="refresh-interval"
          label={t("settings.refresh.interval")}
          value={refreshSeconds}
          onChange={(e) => setRefreshSeconds(Number(e.target.value) as RefreshSeconds)}
        >
          {REFRESH_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {refreshLabel(s)}
            </option>
          ))}
        </Select>
        <Select
          id="refresh-range"
          label={t("settings.refresh.range")}
          value={rangeMinutes}
          onChange={(e) => setRangeMinutes(Number(e.target.value) as RangeMinutes)}
        >
          {RANGE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {formatRange(m)}
            </option>
          ))}
        </Select>
        {summary && <p className="text-xs text-text-2">{t("settings.refresh.collector", { seconds: summary.poll_interval_s })}</p>}
        <p className="text-xs text-muted">{t("settings.refresh.saved")}</p>
      </Card>
    </>
  );
}
