import { BrowserRouter } from "react-router";
import { AuthPage } from "./auth/AuthPage";
import { useAuth } from "./auth/AuthProvider";
import { Shell } from "./components/Shell";
import { Button, Card, Logo } from "./components/ui";
import { t } from "./i18n";

function Splash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-2" role="status">
      <Logo size={40} />
      <p className="text-sm">{t("app.loading")}</p>
    </div>
  );
}

function ConnectionError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <h1 className="text-lg font-medium">{t("conn.title")}</h1>
        <p className="mt-2 text-sm text-text-2">{t("conn.body")}</p>
        <Button className="mt-4" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </Card>
    </main>
  );
}

/** Bramka: ładowanie → błąd połączenia → kreator pierwszego konta → logowanie → aplikacja. */
export function App() {
  const { status, isLoading, isError, refetch } = useAuth();
  if (isLoading) return <Splash />;
  if (isError || !status) return <ConnectionError onRetry={refetch} />;
  if (status.setup_required) return <AuthPage mode="setup" />;
  if (!status.authenticated) return <AuthPage mode="login" />;
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
