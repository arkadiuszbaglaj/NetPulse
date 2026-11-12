import { IconSearch } from "@tabler/icons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { t, type TextKey } from "../i18n";
import { get } from "../lib/api";
import type { InterfaceItem } from "../lib/details";
import { isOn, useModules } from "../lib/modules";
import { PALETTE_GROUPS, searchPalette, type PaletteGroup, type PaletteItem } from "../lib/palette";
import { useDevices } from "../lib/queries";
import type { NetworkClient } from "../lib/unifi";
import { useVisibleModules } from "../modules";
import { KIND_LABEL } from "./widgets/DevicesWidget";

const GROUP_LABEL: Record<PaletteGroup, TextKey> = {
  pages: "palette.group.pages",
  devices: "palette.group.devices",
  ports: "palette.group.ports",
  clients: "palette.group.clients",
};
/** Porty pobieramy osobnym zapytaniem na urządzenie – przy bardzo wielu urządzeniach tylko dla pierwszych */
const MAX_PORT_DEVICES = 40;

/** Wszystko, do czego paleta umie przejść. Strony i urządzenia są od razu (z pamięci panelu), porty i klienci dochodzą. */
function usePaletteItems(): PaletteItem[] {
  const modules = useVisibleModules();
  const unifi = isOn(useModules().data, "unifi");
  const { data: devices } = useDevices();
  // Ten sam klucz co lista klientów w panelu; bez modułu UniFi nie pytamy wcale
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => get<NetworkClient[]>("/api/clients"), enabled: unifi, staleTime: 30_000, retry: false });
  const snmp = useMemo(() => (devices ?? []).filter((d) => d.enabled).slice(0, MAX_PORT_DEVICES), [devices]);
  const ports = useQueries({
    queries: snmp.map((d) => ({
      queryKey: ["device-interfaces", d.id],
      queryFn: () => get<InterfaceItem[]>(`/api/devices/${d.id}/interfaces`),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const portData = ports.map((p) => p.data);
  // Zależność od treści odpowiedzi, nie od tożsamości tablicy (nowa przy każdym renderze)
  const portsStamp = ports.map((p) => p.dataUpdatedAt).join(",");

  return useMemo(() => {
    const items: PaletteItem[] = [];
    for (const m of modules) {
      if (m.hidden) continue;
      if (!m.children) items.push({ id: `page:${m.path}`, group: "pages", label: t(m.label), to: m.path });
      for (const c of m.children ?? []) {
        items.push({ id: `page:${m.path}/${c.path}`, group: "pages", label: t(c.label), detail: t(m.label), to: `${m.path}/${c.path}` });
      }
    }
    for (const d of devices ?? []) {
      items.push({
        id: `device:${d.id}`,
        group: "devices",
        label: d.name,
        detail: [d.host, t(KIND_LABEL[d.kind] ?? "dash.kind.other"), d.model].filter(Boolean).join(" · "),
        keywords: [d.vendor, d.sys_name].filter(Boolean).join(" "),
        to: `/devices/${d.id}`,
      });
    }
    snmp.forEach((d, i) => {
      for (const p of portData[i] ?? []) {
        if (p.hidden) continue;
        items.push({
          id: `port:${p.id}`,
          group: "ports",
          label: p.label || p.name,
          detail: d.name,
          keywords: [p.name, p.alias, p.mac].filter(Boolean).join(" "),
          to: `/devices/${d.id}/ports/${p.id}`,
        });
      }
    });
    if (unifi) {
      for (const c of clients.data ?? []) {
        items.push({
          id: `client:${c.mac}`,
          group: "clients",
          label: c.name ?? c.ip ?? c.mac,
          detail: [c.ip, c.is_wired ? c.uplink_name : c.essid].filter(Boolean).join(" · "),
          keywords: c.mac,
          to: `/clients/${c.mac}`,
        });
      }
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules, devices, snmp, unifi, clients.data, portsStamp]);
}

/**
 * Paleta poleceń: okno wyszukiwania otwierane Ctrl+K (⌘K) albo przyciskiem w pasku górnym. Strzałki wybierają,
 * Enter przechodzi, Escape zamyka. Renderuj warunkowo – dane portów i klientów pobiera dopiero po otwarciu.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const items = usePaletteItems();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchPalette(items, query), [items, query]);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const index = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [index, results]);

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(results.length ? (index + 1) % results.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(results.length ? (index - 1 + results.length) % results.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[index]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t("palette.title")} className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <IconSearch size={18} aria-hidden="true" className="shrink-0 text-muted" />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[index] ? `${listId}-${index}` : undefined}
            aria-label={t("palette.title")}
            placeholder={t("palette.placeholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] !outline-none placeholder:text-muted"
          />
          <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted sm:block">Esc</kbd>
        </div>
        <ul ref={list} id={listId} role="listbox" aria-label={t("palette.results")} className="overflow-y-auto p-2">
          {results.length === 0 && (
            <li role="presentation" className="px-3 py-6 text-center text-sm text-muted">
              {t("palette.none")}
            </li>
          )}
          {PALETTE_GROUPS.map((group) => {
            const rows = results.map((item, i) => ({ item, i })).filter((r) => r.item.group === group);
            if (rows.length === 0) return null;
            return (
              <li key={group} role="presentation">
                <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted">{t(GROUP_LABEL[group])}</p>
                <ul role="group" aria-label={t(GROUP_LABEL[group])}>
                  {rows.map(({ item, i }) => (
                    <li
                      key={item.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === index}
                      onMouseMove={() => setActive(i)}
                      onClick={() => go(item)}
                      className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-sm ${i === index ? "bg-accent-soft text-accent-text" : ""}`}
                    >
                      <span className="min-w-0 truncate font-medium">{item.label}</span>
                      {item.detail && <span className={`min-w-0 shrink truncate text-xs ${i === index ? "" : "text-muted"}`}>{item.detail}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
        <p className="hidden border-t border-border px-4 py-2 text-[11px] text-muted sm:block">{t("palette.keys")}</p>
      </div>
    </div>
  );
}
