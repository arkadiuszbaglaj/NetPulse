import { IconTerminal2 } from "@tabler/icons-react";
import { t } from "../../i18n";

export const UPDATE_COMMAND = "netpulse update";

/**
 * Blok informacyjny na stronie Ustawienia → Aktualizacja: aktualizację można też wykonać
 * z terminala na serwerze. Komenda zaznacza się jednym kliknięciem (schowek przeglądarki nie działa
 * na zwykłym http, a panel często stoi pod adresem IP w sieci lokalnej).
 */
export function UpdateCliHint() {
  return (
    <section aria-labelledby="update-cli-title" className="flex max-w-xl gap-3 rounded-xl bg-accent-soft p-4 text-accent">
      <IconTerminal2 size={22} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 text-sm">
        <h2 id="update-cli-title" className="font-medium">
          {t("update.cli.title")}
        </h2>
        <p className="mt-1">{t("update.cli.body")}</p>
        <code className="mt-2 block select-all overflow-x-auto rounded-lg bg-surface px-3 py-2 font-mono text-xs text-text">
          {UPDATE_COMMAND}
        </code>
        <p className="mt-2 text-xs">{t("update.cli.hint")}</p>
      </div>
    </section>
  );
}
