import { IconWorld } from "@tabler/icons-react";
import { Link } from "react-router";
import { t, type TextKey } from "../../i18n";
import { formatBps, relativeTime } from "../../lib/format";
import { forDevice, useWanStatus, type WanLink, type WanState } from "../../lib/wan";
import { Card, ErrorNote } from "../ui";

export const WAN_STATE_LABEL: Record<WanState, TextKey> = {
  active: "wan.state.active",
  standby: "wan.state.standby",
  down: "wan.state.down",
  unknown: "wan.state.unknown",
};

/** Kropka stanu: zielona – ruch idzie tym łączem, czerwona – łącze nieaktywne (pusta: zapas gotowy, pełna: awaria). */
export function WanDot({ state }: { state: WanState }) {
  const cls = {
    active: "bg-success",
    standby: "border-2 border-danger",
    down: "bg-danger",
    unknown: "bg-border-strong",
  }[state];
  return <span role="img" aria-label={t(WAN_STATE_LABEL[state])} className={`inline-block size-3 shrink-0 rounded-full ${cls}`} />;
}

function LinkRow({ link }: { link: WanLink }) {
  const since = relativeTime(link.state_since);
  return (
    <li className="flex items-start gap-3 py-2">
      <span className="mt-1">
        <WanDot state={link.state} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{link.name}</span>
          <span className="truncate text-xs text-text-2">
            {link.device_name} · {link.interface_label}
          </span>
        </p>
        <p className={`text-xs ${link.state === "active" ? "text-success" : link.state === "unknown" ? "text-text-2" : "text-danger"}`}>
          {t(WAN_STATE_LABEL[link.state])}
          {since && <span className="text-text-2">{` · ${t("wan.since", { when: since })}`}</span>}
        </p>
      </div>
      {link.state === "active" && (
        <p className="shrink-0 text-right text-xs text-text-2">
          <span className="block">↓ {formatBps(link.in_bps)}</span>
          <span className="block">↑ {formatBps(link.out_bps)}</span>
        </p>
      )}
    </li>
  );
}

/** Aktywny WAN: porty WAN routera i ich stan; widać, którym łączem idzie teraz ruch. */
export function WanStatusWidget({ deviceId }: { deviceId?: number | null }) {
  const { data, isLoading, isError } = useWanStatus();
  const links = forDevice(data?.links ?? [], deviceId);
  const active = links.filter((l) => l.state === "active");
  return (
    <Card className="h-full p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <IconWorld size={18} aria-hidden="true" className="shrink-0 text-accent" />
        {t("widget.type.wan_status")}
      </h3>
      {isError ? (
        <ErrorNote>{t("wan.error")}</ErrorNote>
      ) : data && links.length === 0 ? (
        <p className="py-4 text-sm text-text-2">
          {t("wan.none")}{" "}
          <Link to="/settings/wan" className="text-accent hover:underline">
            {t("wan.none.link")}
          </Link>
        </p>
      ) : data ? (
        <>
          <p role="status" className={`text-lg font-medium ${active.length ? "" : "text-danger"}`}>
            {active.length ? t("wan.now", { name: active.map((l) => l.name).join(" + ") }) : t("wan.noActive")}
          </p>
          <ul className="divide-y divide-border">
            {links.map((l) => (
              <LinkRow key={l.id} link={l} />
            ))}
          </ul>
        </>
      ) : (
        isLoading && <p className="py-4 text-sm text-text-2">{t("app.loading")}</p>
      )}
    </Card>
  );
}
