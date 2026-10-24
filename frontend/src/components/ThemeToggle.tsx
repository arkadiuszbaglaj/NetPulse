import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import { t } from "../i18n";
import { useTheme } from "../lib/theme";

const LABEL = { system: "theme.system", light: "theme.light", dark: "theme.dark" } as const;
const ICON = { system: IconDeviceDesktop, light: IconSun, dark: IconMoon } as const;

/** Przełącza motyw: według systemu → jasny → ciemny. */
export function ThemeToggle() {
  const { pref, cycle } = useTheme();
  const Icon = ICON[pref];
  const label = t(LABEL[pref]);
  return (
    <button
      type="button"
      onClick={cycle}
      title={`${label} (${t("theme.switch").toLowerCase()})`}
      aria-label={`${label}. ${t("theme.switch")}`}
      className="flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text"
    >
      <Icon size={20} aria-hidden="true" />
    </button>
  );
}
