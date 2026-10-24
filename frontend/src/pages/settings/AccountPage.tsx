import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useUser } from "../../auth/AuthProvider";
import { Button, Card, ErrorNote, Field, PageHeader, SuccessNote } from "../../components/ui";
import { t } from "../../i18n";
import { ApiError, post } from "../../lib/api";
import { formatDateTime } from "../../lib/format";

const MIN_PASSWORD = 8;

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => post<void>("/api/auth/password", { current_password: current, new_password: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setRepeat("");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    change.reset();
    if (next.length < MIN_PASSWORD) return setLocalError(t("auth.error.short"));
    if (next !== repeat) return setLocalError(t("auth.error.mismatch"));
    change.mutate();
  }

  const serverError = change.error
    ? change.error instanceof ApiError
      ? change.error.message
      : t("auth.error.generic")
    : null;
  const error = localError ?? serverError;

  return (
    <Card className="max-w-md p-5">
      <h2 className="mb-4 text-base font-medium">{t("account.password.title")}</h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          id="current"
          label={t("account.password.current")}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Field
          id="new"
          label={t("account.password.new")}
          type="password"
          autoComplete="new-password"
          hint={t("auth.password.hint")}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <Field
          id="repeat-new"
          label={t("account.password.repeat")}
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
        {error && <ErrorNote>{error}</ErrorNote>}
        {change.isSuccess && <SuccessNote>{t("account.password.done")}</SuccessNote>}
        <div>
          <Button type="submit" variant="primary" disabled={change.isPending || !current || !next}>
            {t("account.password.submit")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function AccountPage() {
  const user = useUser();
  return (
    <>
      <PageHeader title={t("account.title")} />
      <div className="flex flex-col gap-4">
        <Card className="max-w-md p-5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-text-2">{t("account.login")}</dt>
            <dd className="font-medium">{user.username}</dd>
            <dt className="text-text-2">{t("account.role")}</dt>
            <dd>{user.is_admin ? t("user.role.admin") : "-"}</dd>
            <dt className="text-text-2">{t("account.lastLogin")}</dt>
            <dd>{formatDateTime(user.last_login_at)}</dd>
          </dl>
        </Card>
        <PasswordForm />
      </div>
    </>
  );
}
