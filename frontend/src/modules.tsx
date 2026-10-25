/**
 * Rejestr modułów panelu – jedno miejsce, z którego powstaje menu i routing.
 * Nowa sekcja (Alerty, Topologia, Klienci WiFi…) to jeden wpis tutaj.
 */
import {
  IconBell,
  IconBellRinging,
  IconServerCog,
  IconDatabase,
  IconDevicesPc,
  IconDownload,
  IconHeartbeat,
  IconHierarchy2,
  IconLayoutDashboard,
  IconRefresh,
  IconSend,
  IconKey,
  IconPuzzle,
  IconServer2,
  IconSettings,
  IconTerminal2,
  IconUserCircle,
  type Icon,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { TextKey } from "./i18n";
import { isOn, useModules, type ModuleId, type Modules } from "./lib/modules";
import { AgentsPage } from "./pages/settings/AgentsPage";
import { AlertRulesPage } from "./pages/settings/AlertRulesPage";
import { BackupsPage } from "./pages/settings/BackupsPage";
import { ModulesPage } from "./pages/settings/ModulesPage";
import { AlertsPage } from "./pages/AlertsPage";
import { AccountPage } from "./pages/settings/AccountPage";
import { ClientsPage } from "./pages/ClientsPage";
import { ProxmoxPage } from "./pages/ProxmoxPage";
import { ProxmoxSettingsPage } from "./pages/settings/ProxmoxSettingsPage";
import { TopologyPage } from "./pages/TopologyPage";
import { ControllersPage } from "./pages/settings/ControllersPage";
import { DevicesPage } from "./pages/settings/devices/DevicesPage";
import { NotificationsPage } from "./pages/settings/NotificationsPage";
import { RefreshPage } from "./pages/settings/RefreshPage";
import { SystemPage } from "./pages/settings/SystemPage";
import { UpdatePage } from "./pages/settings/UpdatePage";
import { DashboardPage } from "./pages/DashboardPage";

export interface NavChild {
  /** Ścieżka względem rodzica, np. "account" → /settings/account */
  path: string;
  label: TextKey;
  icon: Icon;
  element: ReactNode;
  /** Podstrona modułu z Ustawienia → Moduły – znika, gdy moduł jest wyłączony */
  module?: ModuleId;
}

export interface NavModule {
  id: string;
  /** Ścieżka bezwzględna, np. "/" albo "/settings" */
  path: string;
  label: TextKey;
  icon: Icon;
  /** Moduł bez podstron renderuje `element`. */
  element?: ReactNode;
  /** Moduł z podstronami; wejście na `path` przekierowuje do pierwszej. */
  children?: NavChild[];
  /** Pozycja należy do modułu z Ustawienia → Moduły – znika, gdy moduł jest wyłączony */
  module?: ModuleId;
}

export const modules: NavModule[] = [
  {
    id: "dashboard",
    path: "/",
    label: "nav.dashboard",
    icon: IconLayoutDashboard,
    element: <DashboardPage />,
  },
  {
    id: "clients",
    path: "/clients",
    label: "nav.clients",
    icon: IconDevicesPc,
    element: <ClientsPage />,
    module: "unifi",
  },
  {
    id: "proxmox",
    path: "/proxmox",
    label: "nav.proxmox",
    icon: IconServerCog,
    element: <ProxmoxPage />,
    module: "proxmox",
  },
  {
    id: "topology",
    path: "/topology",
    label: "nav.topology",
    icon: IconHierarchy2,
    element: <TopologyPage />,
    module: "unifi",
  },
  {
    id: "alerts",
    path: "/alerts",
    label: "nav.alerts",
    icon: IconBellRinging,
    element: <AlertsPage />,
  },
  {
    id: "settings",
    path: "/settings",
    label: "nav.settings",
    icon: IconSettings,
    children: [
      { path: "account", label: "nav.settings.account", icon: IconUserCircle, element: <AccountPage /> },
      {
        path: "devices",
        label: "nav.settings.devices",
        icon: IconServer2,
        element: <DevicesPage />,
      },
      {
        path: "agents",
        label: "nav.settings.agents",
        icon: IconTerminal2,
        element: <AgentsPage />,
        module: "agents",
      },
      {
        path: "controllers",
        label: "nav.settings.controllers",
        icon: IconKey,
        element: <ControllersPage />,
        module: "unifi",
      },
      {
        path: "proxmox",
        label: "nav.settings.proxmox",
        icon: IconServerCog,
        element: <ProxmoxSettingsPage />,
        module: "proxmox",
      },
      {
        path: "alert-rules",
        label: "nav.settings.alertRules",
        icon: IconBell,
        element: <AlertRulesPage />,
      },
      {
        path: "notifications",
        label: "nav.settings.notifications",
        icon: IconSend,
        element: <NotificationsPage />,
      },
      {
        path: "refresh",
        label: "nav.settings.refresh",
        icon: IconRefresh,
        element: <RefreshPage />,
      },
      {
        path: "system",
        label: "nav.settings.system",
        icon: IconHeartbeat,
        element: <SystemPage />,
      },
      {
        path: "backups",
        label: "nav.settings.backups",
        icon: IconDatabase,
        element: <BackupsPage />,
        module: "backups",
      },
      {
        path: "modules",
        label: "nav.settings.modules",
        icon: IconPuzzle,
        element: <ModulesPage />,
      },
      {
        path: "update",
        label: "nav.settings.update",
        icon: IconDownload,
        element: <UpdatePage />,
      },
    ],
  },
];

/** Rejestr bez pozycji wyłączonych modułów (menu i trasy). */
export function visibleModules(mods: Modules | undefined): NavModule[] {
  return modules
    .filter((m) => isOn(mods, m.module))
    .map((m) => (m.children ? { ...m, children: m.children.filter((c) => isOn(mods, c.module)) } : m));
}

export function useVisibleModules(): NavModule[] {
  return visibleModules(useModules().data);
}
