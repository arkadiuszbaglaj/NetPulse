import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader, Select } from "../../components/ui";
import { t } from "../../i18n";
import { ApiError, del, patch, post, type User } from "../../lib/api";
import { USERS_KEY, useUsers } from "../../lib/audit";
import { relativeTime } from "../../lib/format";
import { ROLE_LABEL, ROLES, roleOf, type Role } from "../../lib/roles";

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";

const ROLE_STYLE: Record<Role, string> = {
  admin: "bg-accent-soft text-accent-text",
  operator: "bg-warning-soft text-warning",
  viewer: "bg-surface-2 text-text-2",
};

export function RoleBadge({ role }: { role: Role }) {
  return <span className={`rounded-md px-2 py-0.5 text-xs ${ROLE_STYLE[role]}`}>{t(ROLE_LABEL[role])}</span>;
}

function UserForm({ user, onClose }: { user?: User; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = user !== undefined;
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(user ? roleOf(user) : "viewer");
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});

  function validate(): boolean {
    const found: typeof errors = {};
    if (!editing && !username.trim()) found.username = t("users.err.username");
    if ((!editing || password !== "") && password.length < 8) found.password = t("users.err.password");
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  const save = useMutation({
    mutationFn: () =>
      user
        ? patch<User>(`/api/users/${user.id}`, { ...(role !== roleOf(user) ? { role } : {}), ...(password ? { password } : {}) })
        : post<User>("/api/users", { username: username.trim(), password, role }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: USERS_KEY });
      onClose();
    },
  });

  return (
    <Dialog
      title={user ? t("users.form.edit", { name: user.username }) : t("users.form.add")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={save.isPending} onClick={() => validate() && save.mutate()}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!editing && (
          <Field
            id="user-name"
            label={t("users.username")}
            value={username}
            error={errors.username}
            maxLength={64}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
        )}
        <Field
          id="user-password"
          label={t("users.password")}
          type="password"
          autoComplete="new-password"
          value={password}
          error={errors.password}
          hint={editing ? t("users.password.keep") : t("users.password.hint")}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Select id="user-role" label={t("users.role")} value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(ROLE_LABEL[r])}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted">{t(`users.role.hint.${role}`)}</p>
        {editing && <p className="text-xs text-muted">{t("users.relogin")}</p>}
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      </div>
    </Dialog>
  );
}

/** Ustawienia → Konta (tylko administrator): konta panelu z rolą administrator / operator / podgląd. */
export function UsersPage() {
  const qc = useQueryClient();
  const me = useAuth().status?.user;
  const { data, isError } = useUsers();
  const [form, setForm] = useState<{ user?: User } | null>(null);
  const [toDelete, setToDelete] = useState<User | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/users/${id}`),
    onSuccess: async () => {
      setToDelete(null);
      await qc.invalidateQueries({ queryKey: USERS_KEY });
    },
  });

  return (
    <>
      <PageHeader title={t("nav.settings.users")}>
        <Button variant="primary" onClick={() => setForm({})}>
          <IconPlus size={18} aria-hidden="true" />
          {t("users.add")}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("users.intro")}</p>

      {isError && !data && <ErrorNote>{t("users.loadError")}</ErrorNote>}
      {data && (
        <Card>
          <ul className="divide-y divide-border">
            {data.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="truncate text-sm font-medium">
                    {u.username}
                    {u.id === me?.id && <span className="ml-2 text-xs font-normal text-muted">{t("users.you")}</span>}
                  </p>
                  <p className="truncate text-xs text-text-2">
                    {u.last_login_at ? t("users.lastLogin", { when: relativeTime(u.last_login_at) ?? "" }) : t("users.neverLogged")}
                  </p>
                </div>
                <RoleBadge role={roleOf(u)} />
                <div className="flex items-center gap-1">
                  <button type="button" className={iconButton} aria-label={`${t("common.edit")} ${u.username}`} title={t("common.edit")} onClick={() => setForm({ user: u })}>
                    <IconPencil size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`${t("common.delete")} ${u.username}`}
                    title={t("common.delete")}
                    disabled={u.id === me?.id}
                    onClick={() => {
                      remove.reset();
                      setToDelete(u);
                    }}
                  >
                    <IconTrash size={18} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {form && <UserForm user={form.user} onClose={() => setForm(null)} />}
      {toDelete && (
        <Dialog
          size="sm"
          title={t("users.delete.title")}
          onClose={() => setToDelete(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setToDelete(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(toDelete.id)}>
                {remove.isPending ? t("devices.delete.busy") : t("common.delete")}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t("users.delete.body", { name: toDelete.username })}</p>
          {remove.isError && (
            <div className="mt-3">
              <ErrorNote>{errorMessage(remove.error)}</ErrorNote>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
