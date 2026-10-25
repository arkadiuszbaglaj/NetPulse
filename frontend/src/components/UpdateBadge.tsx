import { IconDownload, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";
import { t } from "../i18n";
import { availableUpdate, useUpdates } from "../lib/updatesApi";

const DISMISSED_KEY = "netpulse.updateDismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** Plakietka w pasku górnym: jest nowa wersja (po automatycznym albo ręcznym sprawdzeniu). Można ją ukryć do następnej wersji. */
export function UpdateBadge() {
  const { data } = useUpdates();
  const [dismissed, setDismissed] = useState(readDismissed);
  const update = availableUpdate(data);
  if (!update || update.id === dismissed) return null;

  const label = update.version ? t("update.badge", { version: update.version }) : t("update.badgeNoVersion");
  const hide = () => {
    setDismissed(update.id);
    try {
      localStorage.setItem(DISMISSED_KEY, update.id);
    } catch {
      /* bez zapamiętywania */
    }
  };
  return (
    <div className="flex items-center rounded-lg bg-accent-soft text-accent">
      <Link
        to="/settings/update"
        className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <IconDownload size={16} aria-hidden="true" />
        <span className="max-sm:sr-only">{label}</span>
      </Link>
      <button
        type="button"
        onClick={hide}
        aria-label={t("update.badge.hide")}
        title={t("update.badge.hide")}
        className="flex size-8 items-center justify-center rounded-lg hover:bg-accent/10"
      >
        <IconX size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
