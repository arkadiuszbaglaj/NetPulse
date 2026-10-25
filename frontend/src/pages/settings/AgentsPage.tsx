import { IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader } from "../../components/ui";
import { t, type TextKey } from "../../i18n";
import { AGENTS_KEY, installCommand, uninstallCommand, updateCommand, useAgents, type Agent, type AgentToken } from "../../lib/agents";
import { ApiError, del, post } from "../../lib/api";
import { relativeTime } from "../../lib/format";

const STATUS_STYLE: Record<string, string> = {
  up: "bg-success-soft text-success",
  down: "bg-danger-soft text-danger",
  unknown: "bg-surface-2 text-text-2",
};
const STATUS_LABEL: Record<string, TextKey> = {
  up: "dash.status.up",
  down: "dash.status.down",
  unknown: "agents.status.waiting",
};

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";

/** Polecenie do zaznaczenia jednym kliknięciem (schowek przeglądarki nie działa na zwykłym http). */
function Command({ label, command }: { label: string; command: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">{label}</p>
      <code aria-label={label} className="block select-all break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-text">
        {command}
      </code>
    </div>
  );
}

/** Token pokazywany tylko raz, od razu jako gotowe polecenie instalacji. */
function TokenDialog({ result, onClose }: { result: AgentToken; onClose: () => void }) {
  const origin = window.location.origin;
  return (
    <Dialog
      title={t("agents.token.title", { name: result.agent.name })}
      onClose={onClose}
      footer={
        <Button variant="primary" data-autofocus onClick={onClose}>
          {t("agents.token.done")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p>{t("agents.token.body")}</p>
        <Command label={t("agents.token.command")} command={installCommand(origin, result.token)} />
        <p className="text-xs text-text-2">{t("agents.token.once")}</p>
        <p className="text-xs text-text-2">{t("agents.token.requirements")}</p>
      </div>
    </Dialog>
  );
}

function AddDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: AgentToken) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const create = useMutation({
    mutationFn: () => post<AgentToken>("/api/agents", { name: name.trim() }),
    onSuccess: async (result) => {
      await Promise.all([qc.invalidateQueries({ queryKey: AGENTS_KEY }), qc.invalidateQueries({ queryKey: ["devices"] })]);
      onCreated(result);
    },
  });
  const submit = () => {
    if (!name.trim()) {
      setError(t("agents.err.name"));
      return;
    }
    create.mutate();
  };
  return (
    <Dialog
      size="sm"
      title={t("agents.add")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={create.isPending} onClick={submit}>
            {create.isPending ? t("common.saving") : t("agents.add.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          id="agent-name"
          label={t("devform.name")}
          value={name}
          error={error}
          hint={t("agents.name.hint")}
          maxLength={128}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {create.isError && <ErrorNote>{errorMessage(create.error)}</ErrorNote>}
      </div>
    </Dialog>
  );
}

function AgentRow({ agent, onToken, onDelete }: { agent: Agent; onToken: () => void; onDelete: () => void }) {
  const status = agent.status in STATUS_STYLE ? agent.status : "unknown";
  const seen = relativeTime(agent.last_seen_at);
  const details = [
    agent.hostname,
    agent.agent_version ? t("agents.row.version", { version: agent.agent_version }) : null,
    seen ? t("agents.row.seen", { when: seen }) : t("agents.row.never"),
    t("agents.row.token", { hint: agent.token_hint }),
  ].filter(Boolean);
  return (
    <li className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${agent.enabled ? "" : "opacity-70"}`}>
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-sm font-medium">{agent.name}</p>
        <p className="truncate text-xs text-text-2">{details.join(" · ")}</p>
      </div>
      {agent.outdated && (
        <span className="rounded-md bg-warning-soft px-2 py-0.5 text-xs text-warning" title={t("agents.outdated.hint")}>
          {t("agents.outdated")}
        </span>
      )}
      {agent.enabled ? (
        <span className={`rounded-md px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>{t(STATUS_LABEL[status])}</span>
      ) : (
        <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-text-2">{t("devices.disabled")}</span>
      )}
      <div className="flex items-center gap-1">
        <button type="button" className={iconButton} aria-label={`${t("agents.newToken")}: ${agent.name}`} title={t("agents.newToken")} onClick={onToken}>
          <IconKey size={18} aria-hidden="true" />
        </button>
        <button type="button" className={iconButton} aria-label={`${t("common.delete")} ${agent.name}`} title={t("common.delete")} onClick={onDelete}>
          <IconTrash size={18} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/** Ustawienia → Agenci: serwery Linux z agentem NetPulse (kontenery, usługi, temperatury, SMART). */
export function AgentsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useAgents();
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<AgentToken | null>(null);
  const [toRotate, setToRotate] = useState<Agent | null>(null);
  const [toDelete, setToDelete] = useState<Agent | null>(null);

  const rotate = useMutation({
    mutationFn: (id: number) => post<AgentToken>(`/api/agents/${id}/token`),
    onSuccess: async (result) => {
      setToRotate(null);
      setShown(result);
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
    },
  });
  const remove = useMutation({
    mutationFn: (deviceId: number) => del(`/api/devices/${deviceId}`),
    onSuccess: async () => {
      setToDelete(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: AGENTS_KEY }),
        qc.invalidateQueries({ queryKey: ["devices"] }),
        qc.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
    },
  });
  const list = data ?? [];
  const outdated = list.filter((a) => a.outdated);

  return (
    <>
      <PageHeader title={t("settings.agents.title")}>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <IconPlus size={18} aria-hidden="true" />
          {t("agents.add")}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("agents.intro")}</p>

      {isError && !data && <ErrorNote>{t("agents.loadError")}</ErrorNote>}
      {!isLoading && !isError && list.length === 0 && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("agents.empty.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-2">{t("agents.empty.body")}</p>
        </Card>
      )}
      {list.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {list.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                onToken={() => {
                  rotate.reset();
                  setToRotate(a);
                }}
                onDelete={() => {
                  remove.reset();
                  setToDelete(a);
                }}
              />
            ))}
          </ul>
        </Card>
      )}
      {outdated.length > 0 && (
        <Card className="mt-3 p-4">
          <h2 className="text-sm font-medium">{t("agents.update.title", { names: outdated.map((a) => a.name).join(", ") })}</h2>
          <p className="mb-3 mt-1 max-w-prose text-sm text-text-2">{t("agents.update.body")}</p>
          <Command label={t("agents.update.command")} command={updateCommand(window.location.origin)} />
        </Card>
      )}

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onCreated={(result) => {
            setAdding(false);
            setShown(result);
          }}
        />
      )}
      {shown && <TokenDialog result={shown} onClose={() => setShown(null)} />}

      {toRotate && (
        <Dialog
          size="sm"
          title={t("agents.rotate.title")}
          onClose={() => setToRotate(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setToRotate(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" disabled={rotate.isPending} onClick={() => rotate.mutate(toRotate.id)}>
                {t("agents.newToken")}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t("agents.rotate.body", { name: toRotate.name })}</p>
          {rotate.isError && (
            <div className="mt-3">
              <ErrorNote>{errorMessage(rotate.error)}</ErrorNote>
            </div>
          )}
        </Dialog>
      )}

      {toDelete && (
        <Dialog
          title={t("agents.delete.title")}
          onClose={() => setToDelete(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setToDelete(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(toDelete.device_id)}>
                {remove.isPending ? t("devices.delete.busy") : t("common.delete")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4 text-sm">
            <p>{t("agents.delete.body", { name: toDelete.name })}</p>
            <Command label={t("agents.delete.uninstall")} command={uninstallCommand(window.location.origin)} />
            {remove.isError && <ErrorNote>{errorMessage(remove.error)}</ErrorNote>}
          </div>
        </Dialog>
      )}
    </>
  );
}
