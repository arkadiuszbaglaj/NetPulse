import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { Button, Card, ErrorNote, Field, PageHeader, Select, SuccessNote } from "../../components/ui";
import { t } from "../../i18n";
import { ApiError, get, request, type Device } from "../../lib/api";
import { useDevices } from "../../lib/queries";
import { useWanLinks, WAN_LINKS_KEY, type WanLink } from "../../lib/wan";

const MAX_LINKS = 4;
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-40";

interface Row {
  key: string;
  device_id: number | null;
  interface_id: number | null;
  name: string;
}
interface PortItem {
  id: number;
  name: string;
  label: string;
  alias: string | null;
  role: string;
}

const rowOf = (l: WanLink): Row => ({ key: `l${l.id}`, device_id: l.device_id, interface_id: l.interface_id, name: l.name });

function LinkRow({
  row,
  index,
  count,
  routers,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  row: Row;
  index: number;
  count: number;
  routers: Device[];
  disabled: boolean;
  onChange: (patch: Partial<Row>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const ports = useQuery({
    queryKey: ["device-interfaces", row.device_id],
    queryFn: () => get<PortItem[]>(`/api/devices/${row.device_id}/interfaces`),
    enabled: row.device_id != null,
  });
  const n = index + 1;
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-end">
      <span className="text-sm font-medium sm:w-16 sm:pb-2">{t("wan.cfg.position", { n })}</span>
      <div className="grid flex-1 gap-3 sm:grid-cols-3">
        <Select
          id={`wan-dev-${row.key}`}
          label={t("wan.cfg.device")}
          value={row.device_id ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ device_id: e.target.value ? Number(e.target.value) : null, interface_id: null })}
        >
          <option value="">{t("ce.choose")}</option>
          {routers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <Select
          id={`wan-port-${row.key}`}
          label={t("wan.cfg.port")}
          value={row.interface_id ?? ""}
          disabled={disabled || row.device_id == null}
          onChange={(e) => onChange({ interface_id: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">{t("ce.choose")}</option>
          {(ports.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.label} (${p.name})${p.alias ? ` – ${p.alias}` : ""}`}
            </option>
          ))}
        </Select>
        <Field id={`wan-name-${row.key}`} label={t("wan.cfg.name")} value={row.name} maxLength={64} disabled={disabled} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="flex gap-1">
        <button type="button" className={iconButton} aria-label={t("wan.cfg.up", { n })} disabled={disabled || index === 0} onClick={() => onMove(-1)}>
          <IconArrowUp size={18} aria-hidden="true" />
        </button>
        <button type="button" className={iconButton} aria-label={t("wan.cfg.down", { n })} disabled={disabled || index === count - 1} onClick={() => onMove(1)}>
          <IconArrowDown size={18} aria-hidden="true" />
        </button>
        <button type="button" className={iconButton} aria-label={t("wan.cfg.remove", { n })} disabled={disabled} onClick={onRemove}>
          <IconTrash size={18} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/** Ustawienia → Łącza WAN: które porty routera są WAN 1, WAN 2 … (kolejność = priorytet w failoverze). */
export function WanLinksPage() {
  const qc = useQueryClient();
  const { status } = useAuth();
  const admin = status?.user?.is_admin ?? false;
  const links = useWanLinks();
  const devices = useDevices();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (links.data && rows === null) setRows(links.data.map(rowOf));
  }, [links.data, rows]);

  const routers = (devices.data ?? []).filter((d) => d.kind === "gateway" || rows?.some((r) => r.device_id === d.id));
  const save = useMutation({
    mutationFn: (items: Row[]) =>
      request<WanLink[]>("PUT", "/api/wan/links", { links: items.map((r) => ({ interface_id: r.interface_id, name: r.name.trim() })) }),
    onSuccess: async (saved) => {
      qc.setQueryData(WAN_LINKS_KEY, saved);
      setRows(saved.map(rowOf));
      await qc.invalidateQueries({ queryKey: ["wan"] });
    },
  });

  const update = (i: number, patch: Partial<Row>) => {
    save.reset();
    setRows((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const move = (i: number, delta: -1 | 1) =>
    setRows((rs) => {
      const next = [...(rs ?? [])];
      [next[i], next[i + delta]] = [next[i + delta], next[i]];
      return next;
    });
  const add = () => {
    save.reset();
    setRows((rs) => {
      const list = rs ?? [];
      const device = list[list.length - 1]?.device_id ?? (routers.length === 1 ? routers[0].id : null);
      return [...list, { key: `n${Date.now()}`, device_id: device, interface_id: null, name: `WAN ${list.length + 1}` }];
    });
  };
  const submit = () => {
    const list = rows ?? [];
    if (list.some((r) => r.interface_id == null)) return setError(t("wan.cfg.err.port"));
    if (list.some((r) => !r.name.trim())) return setError(t("wan.cfg.err.name"));
    if (new Set(list.map((r) => r.interface_id)).size !== list.length) return setError(t("wan.cfg.err.duplicate"));
    setError(null);
    save.mutate(list);
  };

  return (
    <>
      <PageHeader title={t("settings.wan.title")} />
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("wan.cfg.intro")}</p>
      {links.isError && <ErrorNote>{t("wan.error")}</ErrorNote>}
      {rows && (
        <Card>
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-text-2">{t("wan.cfg.empty")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r, i) => (
                <LinkRow
                  key={r.key}
                  row={r}
                  index={i}
                  count={rows.length}
                  routers={routers}
                  disabled={!admin || save.isPending}
                  onChange={(p) => update(i, p)}
                  onMove={(d) => move(i, d)}
                  onRemove={() => setRows(rows.filter((_, j) => j !== i))}
                />
              ))}
            </ul>
          )}
        </Card>
      )}
      {admin && rows && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={add} disabled={save.isPending || rows.length >= MAX_LINKS * 2}>
            <IconPlus size={16} aria-hidden="true" />
            {t("wan.cfg.add")}
          </Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {error && <ErrorNote>{error}</ErrorNote>}
        {save.isError && <ErrorNote>{save.error instanceof ApiError ? save.error.message : t("auth.error.generic")}</ErrorNote>}
        {save.isSuccess && <SuccessNote>{t("wan.cfg.saved")}</SuccessNote>}
      </div>
      <p className="mt-4 max-w-prose text-xs text-text-2">{admin ? t("wan.cfg.hint") : t("wan.cfg.adminOnly")}</p>
    </>
  );
}
