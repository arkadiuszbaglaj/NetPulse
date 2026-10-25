/**
 * Rejestr modułów panelu – jedno miejsce, z którego powstaje menu i routing.
 * Nowa sekcja (Alerty, Topologia, Klienci WiFi…) to jeden wpis tutaj.
 */
import {
  IconDevicesPc,
  IconDownload,
  IconHierarchy2,
  IconLayoutDashboard,
  IconRefresh,
  IconKey,
  IconServer2,
  IconSettings,
  IconUserCircle,
  type Icon,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { TextKey } from "./i18n";
import { AccountPage } from "./pages/settings/AccountPage";
import { ClientsPage } from "./pages/ClientsPage";
import { TopologyPage } from "./pages/TopologyPage";
import { ControllersPage } from "./pages/settings/ControllersPage";
import { DevicesPage } from "./pages/settings/devices/DevicesPage";
import { RefreshPage } from "./pages/settings/RefreshPage";
import { UpdatePage } from "./pages/settings/UpdatePage";
import { DashboardPage } from "./pages/DashboardPage";

export interface NavChild {
  /** Ścieżka względem rodzica, np. "account" → /settings/account */
  path: string;
  label: TextKey;
  icon: Icon;
  element: ReactNode;
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
  },
  {
    id: "topology",
    path: "/topology",
    label: "nav.topology",
    icon: IconHierarchy2,
    element: <TopologyPage />,
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
        path: "controllers",
        label: "nav.settings.controllers",
        icon: IconKey,
        element: <ControllersPage />,
      },
      {
        path: "refresh",
        label: "nav.settings.refresh",
        icon: IconRefresh,
        element: <RefreshPage />,
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
