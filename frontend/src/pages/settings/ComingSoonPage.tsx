import { Card, PageHeader } from "../../components/ui";
import { useAuth } from "../../auth/AuthProvider";
import { t, type TextKey } from "../../i18n";

/** Sekcja zapowiedziana w menu, ale jeszcze nieoprawiona w interfejsie. */
export function ComingSoonPage({ title, showVersion }: { title: TextKey; showVersion?: boolean }) {
  const { status } = useAuth();
  return (
    <>
      <PageHeader title={t(title)} />
      <Card className="max-w-xl p-5">
        {showVersion && status && (
          <p className="mb-2 text-sm">
            {t("settings.update.version")}: <span className="font-medium">{status.version}</span>
          </p>
        )}
        <p className="text-sm text-text-2">{t("common.comingSoon")}</p>
      </Card>
    </>
  );
}
