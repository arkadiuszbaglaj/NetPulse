/** Kafelek „Zdarzenia” (od 0.49.0): przełączenia WAN i restarty urządzeń z ostatnich dni, najnowsze na górze.
 * Na wykresach tych zdarzeń nie ma – są tu, a jako alerty na liście alertów i pod dzwonkiem. */
import { IconArrowsExchange, IconRefresh, IconShieldLock } from "@tabler/icons-react";
import { t } from "../../i18n";
import { useEvents, type EventKind } from "../../lib/events";
import { relativeTime } from "../../lib/format";
import type { EventsDays } from "../../lib/layout";
import { useRefresh } from "../../lib/refresh";
import { Card, ErrorNote } from "../ui";

const ICON: Record<EventKind, typeof IconRefresh> = { wan_switch: IconArrowsExchange, restart: IconRefresh, vpn_connect: IconShieldLock };
const timeFmt = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "short" });

export function EventsWidget({ days, limit }: { days: EventsDays; limit: number }) {
  const { refetchInterval } = useRefresh();
  const query = useEvents(days * 24 * 60, 0, refetchInterval, true);
  const list = [...(query.data ?? [])].reverse().slice(0, limit);
  return (
    <Card className="flex h-full flex-col p-5">
      <h2 className="pb-3 text-base font-semibold">{t("widget.type.events")}</h2>
      {query.isError && <ErrorNote>{t("dash.error")}</ErrorNote>}
      {query.data && list.length === 0 && <p className="text-sm text-muted">{t(`eventsWidget.none.${days}`)}</p>}
      <ul className="flex flex-col">
        {list.map((e) => {
          const Icon = ICON[e.kind];
          return (
            <li key={`${e.kind}-${e.time}-${e.device_id}`} className="flex gap-3 border-t border-border/60 py-3 first:border-t-0 first:pt-0">
              <Icon size={18} aria-hidden="true" className={`mt-0.5 shrink-0 ${e.kind === "wan_switch" ? "text-accent-text" : "text-text-2"}`} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={e.title}>
                  {t(`event.${e.kind}`)}: {e.title}
                </p>
                <p className="text-xs text-muted" title={timeFmt.format(new Date(e.time))}>
                  {[relativeTime(e.time), timeFmt.format(new Date(e.time))].filter(Boolean).join(" · ")}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
