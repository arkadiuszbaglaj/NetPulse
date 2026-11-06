/** Potwierdzenie danych (od 0.64.0): plakietka przy urządzeniu i lista źródeł w Ustawienia → System.
 * Źródło prawdy: backend/netpulse/verification.py (`GET /api/system/verification`, `Device.verification`). */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { t, type TextKey } from "../i18n";
import { get, type Device } from "../lib/api";
import { Card, ErrorNote } from "./ui";

export type VerificationLevel = "verified" | "partial" | "test";

export interface VerificationSource {
  id: string;
  label: string;
  level: VerificationLevel;
  note: string;
  drivers: string[];
}

const LEVEL_LABEL: Record<VerificationLevel, TextKey> = {
  verified: "verify.level.verified",
  partial: "verify.level.partial",
  test: "verify.level.test",
};
const LEVEL_STYLE: Record<VerificationLevel, string> = {
  verified: "bg-success-soft text-success",
  partial: "bg-warning-soft text-warning",
  test: "bg-surface-2 text-text-2",
};

/** Plakietka przy urządzeniu, którego driver nie jest w pełni sprawdzony na prawdziwym sprzęcie (potwierdzone – bez plakietki). */
export function VerificationBadge({ device }: { device: Pick<Device, "verification"> }) {
  const level = device.verification;
  if (level !== "partial" && level !== "test") return null;
  return (
    <Link
      to="/settings/system#verification"
      className={`shrink-0 rounded-md px-2 py-0.5 text-xs hover:underline ${LEVEL_STYLE[level]}`}
      title={t(level === "test" ? "verify.badge.test.hint" : "verify.badge.partial.hint")}
    >
      {t(level === "test" ? "verify.badge.test" : "verify.badge.partial")}
    </Link>
  );
}

/** Lista źródeł danych z poziomem potwierdzenia. */
export function VerificationCard() {
  const { data, isError } = useQuery({
    queryKey: ["system", "verification"],
    queryFn: () => get<VerificationSource[]>("/api/system/verification"),
    staleTime: 10 * 60_000,
  });
  if (isError) return <ErrorNote>{t("verify.error")}</ErrorNote>;
  return (
    <Card>
      <ul className="divide-y divide-border" aria-label={t("verify.title")}>
        {(data ?? []).map((s) => (
          <li key={s.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1 basis-64">
              <p className="font-medium">{s.label}</p>
              <p className="text-xs text-text-2">{s.note}</p>
            </div>
            <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${LEVEL_STYLE[s.level] ?? LEVEL_STYLE.test}`}>
              {t(LEVEL_LABEL[s.level] ?? "verify.level.test")}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
