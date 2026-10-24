import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorNote, Field, Logo } from "../components/ui";
import { t } from "../i18n";
import { ApiError, post, type User } from "../lib/api";
import { AUTH_KEY } from "./AuthProvider";

const MIN_PASSWORD = 8;

/** Ekran logowania albo kreatora pierwszego konta (gdy w bazie nie ma jeszcze użytkowników). */
export function AuthPage({ mode }: { mode: "login" | "setup" }) {
  const qc = useQueryClient();
  const setup = mode === "setup";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () => post<User>(setup ? "/api/auth/setup" : "/api/auth/login", { username, password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUTH_KEY }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (setup) {
      if (password.length < MIN_PASSWORD) return setLocalError(t("auth.error.short"));
      if (password !== repeat) return setLocalError(t("auth.error.mismatch"));
    }
    submit.mutate();
  }

  const serverError = submit.error
    ? submit.error instanceof ApiError
      ? submit.error.message
      : t("auth.error.generic")
    : null;
  const error = localError ?? serverError;

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <Logo size={36} />
          <div>
            <p className="text-sm font-medium text-text-2">{t("app.name")}</p>
            <h1 className="text-xl font-medium leading-tight">{setup ? t("auth.setup.title") : t("auth.login.title")}</h1>
          </div>
        </div>
        <p className="mb-5 text-sm text-text-2">{setup ? t("auth.setup.subtitle") : t("auth.login.subtitle")}</p>

        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <Field
            id="username"
            label={t("auth.username")}
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Field
            id="password"
            label={t("auth.password")}
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            required
            hint={setup ? t("auth.password.hint") : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {setup && (
            <Field
              id="repeat"
              label={t("auth.password.repeat")}
              type="password"
              autoComplete="new-password"
              required
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button type="submit" variant="primary" disabled={submit.isPending || !username || !password}>
            {submit.isPending
              ? setup
                ? t("auth.setup.busy")
                : t("auth.login.busy")
              : setup
                ? t("auth.setup.submit")
                : t("auth.login.submit")}
          </Button>
        </form>
      </Card>
    </main>
  );
}
