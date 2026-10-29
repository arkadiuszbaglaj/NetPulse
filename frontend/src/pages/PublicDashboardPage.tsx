import { IconMaximize } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button, Card, ErrorNote, Field, Logo } from "../components/ui";
import { WidgetView, widgetTitle } from "../components/widgets/registry";
import { t } from "../i18n";
import { ApiError, get, post, setPublicDashboard } from "../lib/api";
import type { PublicDashboard } from "../lib/dashboards";
import { PublicModeContext } from "../lib/publicMode";
import { RefreshProvider } from "../lib/refresh";
import { DashboardGrid } from "../components/DashboardGrid";

const accessKey = (token: string) => `netpulse.public.${token}`;

function readAccess(token: string): string | null {
  try {
    return sessionStorage.getItem(accessKey(token));
  } catch {
    return null;
  }
}

function PinForm({ token, name, onUnlocked }: { token: string; name: string; onUnlocked: (access: string) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { access } = await post<{ access: string }>(`/api/public/dashboards/${token}/unlock`, { pin });
      onUnlocked(access);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.error.generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-4 flex items-center gap-2">
          <Logo size={28} />
          <h1 className="text-lg font-medium">{name}</h1>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field id="public-pin" label={t("public.pin")} type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button type="submit" variant="primary" disabled={busy || !pin}>
            {t("public.unlock")}
          </Button>
        </form>
      </Card>
    </main>
  );
}

function Message({ title, body }: { title: string; body?: string }) {
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <Logo size={32} />
        <h1 className="mt-3 text-lg font-medium">{title}</h1>
        {body && <p className="mt-2 text-sm text-text-2">{body}</p>}
      </Card>
    </main>
  );
}

/** Pulpit publiczny pod /p/<token>: bez logowania, tylko do odczytu, bez menu (np. wyświetlacz ścienny).
 * `?kiosk=1` chowa też pasek z nazwą – na telewizor albo tablet na ścianie. */
export function PublicDashboardPage() {
  const token = useParams().token ?? "";
  const qc = useQueryClient();
  const [access, setAccess] = useState(() => readAccess(token));
  const kiosk = new URLSearchParams(window.location.search).get("kiosk") === "1";
  // Ustawione już w trakcie renderu, przed widgetami: ich zapytania od razu idą do API publicznego
  setPublicDashboard({ token, access });
  useEffect(() => {
    setPublicDashboard({ token, access });
    return () => setPublicDashboard(null);
  }, [token, access]);
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  const page = useQuery({
    queryKey: ["public-dashboard", token, access],
    queryFn: () => get<PublicDashboard>(`/api/public/dashboards/${token}`),
    retry: false,
    refetchInterval: 5 * 60_000, // zmiana układu albo wyłączenie linku dociera bez przeładowania
  });

  useEffect(() => {
    if (page.data?.name) document.title = `${page.data.name} · NetPulse`;
  }, [page.data?.name]);

  if (page.isLoading) return <Message title={t("app.loading")} />;
  if (page.isError || !page.data) {
    const gone = page.error instanceof ApiError && page.error.status === 404;
    return <Message title={t(gone ? "public.gone" : "conn.title")} body={t(gone ? "public.gone.body" : "conn.body")} />;
  }
  const d = page.data;
  if (d.locked || !d.layout) {
    return (
      <PinForm
        token={token}
        name={d.name}
        onUnlocked={(value) => {
          try {
            sessionStorage.setItem(accessKey(token), value);
          } catch {
            /* bez zapamiętywania – PIN trzeba będzie podać po odświeżeniu */
          }
          setAccess(value);
          void qc.invalidateQueries();
        }}
      />
    );
  }

  const fullscreen = () => void document.documentElement.requestFullscreen?.().catch(() => undefined);
  return (
    <PublicModeContext.Provider value={true}>
      <RefreshProvider fixed={{ refreshSeconds: d.options.refresh_s, rangeMinutes: d.options.range_min }}>
        <div className="flex min-h-full flex-col">
          {!kiosk && (
            <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-3 sm:px-4">
              <div className="flex min-w-0 items-center gap-2">
                <Logo size={28} />
                <h1 className="truncate text-base font-medium">{d.name}</h1>
              </div>
              <div className="flex items-center gap-1">
                <span className="hidden text-xs text-text-2 sm:inline">{t("public.refresh", { s: d.options.refresh_s })}</span>
                <button
                  type="button"
                  onClick={fullscreen}
                  aria-label={t("public.fullscreen")}
                  title={t("public.fullscreen")}
                  className="flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text"
                >
                  <IconMaximize size={20} aria-hidden="true" />
                </button>
                <ThemeToggle />
              </div>
            </header>
          )}
          <main className="min-w-0 flex-1 p-4 sm:p-6">
            {d.layout.widgets.length === 0 ? (
              <p className="py-10 text-center text-sm text-text-2">{t("dash.empty.layout")}</p>
            ) : (
              <DashboardGrid widgets={d.layout.widgets} scope={`public.${token}`} renderWidget={(widget) => <WidgetView widget={widget} />} widgetLabel={widgetTitle} />
            )}
          </main>
        </div>
      </RefreshProvider>
    </PublicModeContext.Provider>
  );
}
