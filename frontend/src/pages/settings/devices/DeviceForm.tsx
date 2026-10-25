import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../../../components/Dialog";
import { Button, Card, ErrorNote, Field, Select } from "../../../components/ui";
import { t } from "../../../i18n";
import { ApiError, patch, post, type Device, type ProbeResult } from "../../../lib/api";
import { ProbeSummary } from "./ProbeSummary";
import {
  AUTH_PROTOCOLS,
  DRIVERS,
  PRIV_PROTOCOLS,
  SNMP_VERSIONS,
  buildCreate,
  buildPatch,
  buildTarget,
  emptyForm,
  formFromDevice,
  isEmptyPatch,
  validate,
  type DeviceFormValues,
  type FormErrors,
} from "./deviceFormLogic";

const FORM_ID = "device-form";

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : t("auth.error.generic");
}

interface DeviceFormProps {
  /** Brak = dodawanie nowego urządzenia */
  device?: Device;
  onClose: () => void;
  /** Formularz w treści strony (kreator pierwszej konfiguracji) zamiast okna */
  inline?: boolean;
  /** Wywoływane po zapisaniu urządzenia */
  onSaved?: (device: Device) => void;
}

/** Okno dodawania i edycji urządzenia (SNMP v1/v2c/v3) z testem połączenia. */
export function DeviceForm({ device, onClose, inline = false, onSaved }: DeviceFormProps) {
  const qc = useQueryClient();
  const editing = device !== undefined;
  const [values, setValues] = useState<DeviceFormValues>(() => (device ? formFromDevice(device) : emptyForm()));
  const [errors, setErrors] = useState<FormErrors>({});
  const [note, setNote] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);

  const set = <K extends keyof DeviceFormValues>(key: K, value: DeviceFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setNote(null);
  };

  const refreshLists = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["devices"] }), qc.invalidateQueries({ queryKey: ["dashboard"] })]);

  const probe = useMutation({
    mutationFn: () => post<ProbeResult>("/api/probe", buildTarget(values)),
    onSuccess: (result) => setProbeResult(result),
  });

  const save = useMutation({
    mutationFn: async (probeFirst: boolean) => {
      if (device) return patch<Device>(`/api/devices/${device.id}`, buildPatch(values, device));
      return post<Device>(`/api/devices${probeFirst ? "" : "?probe=false"}`, buildCreate(values));
    },
    onSuccess: async (saved) => {
      await refreshLists();
      onSaved?.(saved);
      if (!inline) onClose();
    },
  });

  function checkValid(): boolean {
    const found = validate(values, device);
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  function onSubmit(e: { preventDefault(): void }, probeFirst = true) {
    e.preventDefault();
    setNote(null);
    probe.reset();
    setProbeResult(null);
    if (!checkValid()) return;
    if (device && isEmptyPatch(buildPatch(values, device))) {
      setNote(t("devform.nothingChanged"));
      return;
    }
    save.mutate(probeFirst);
  }

  function onTest() {
    save.reset();
    setProbeResult(null);
    if (!checkValid()) return;
    probe.mutate();
  }

  const v3 = values.snmp_version === "3";
  // Po nieudanym teście przy zapisie (422) pozwalamy zapisać urządzenie, które jest chwilowo niedostępne
  const canSaveAnyway = !editing && save.error instanceof ApiError && save.error.status === 422;
  const busy = save.isPending || probe.isPending;

  const footer = (
    <>
      {!editing && (
        <Button onClick={onTest} disabled={busy} className="mr-auto">
          {probe.isPending ? t("devices.testing") : t("devform.test")}
        </Button>
      )}
      {!inline && <Button onClick={onClose}>{t("common.cancel")}</Button>}
      {canSaveAnyway && (
        <Button disabled={busy} onClick={(e) => onSubmit(e, false)}>
          {t("devform.saveAnyway")}
        </Button>
      )}
      <Button type="submit" form={FORM_ID} variant="primary" disabled={busy}>
        {save.isPending ? t("common.saving") : t("devform.save")}
      </Button>
    </>
  );

  const form = (
      <form id={FORM_ID} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field
          id="dev-name"
          label={t("devform.name")}
          value={values.name}
          error={errors.name}
          maxLength={128}
          onChange={(e) => set("name", e.target.value)}
        />
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field
            id="dev-host"
            label={t("devform.host")}
            value={values.host}
            error={errors.host}
            placeholder="192.168.1.2"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => set("host", e.target.value)}
          />
          <Field
            id="dev-port"
            label={t("devform.port")}
            inputMode="numeric"
            value={values.port}
            error={errors.port}
            onChange={(e) => set("port", e.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            id="dev-version"
            label={t("devform.version")}
            value={values.snmp_version}
            onChange={(e) => set("snmp_version", e.target.value as DeviceFormValues["snmp_version"])}
          >
            {SNMP_VERSIONS.map((v) => (
              <option key={v} value={v}>
                {t(`devform.version.${v}` as const)}
              </option>
            ))}
          </Select>
          <Select
            id="dev-driver"
            label={t("devform.driver")}
            value={values.driver}
            onChange={(e) => set("driver", e.target.value as DeviceFormValues["driver"])}
          >
            {DRIVERS.map((d) => (
              <option key={d} value={d}>
                {t(`devform.driver.${d}` as const)}
              </option>
            ))}
          </Select>
        </div>
        {values.driver === "linux" && <p className="-mt-2 text-xs text-text-2">{t("devform.linuxHint")}</p>}

        {!v3 ? (
          <Field
            id="dev-community"
            label={t("devform.community")}
            type="password"
            autoComplete="new-password"
            value={values.community}
            error={errors.community}
            hint={editing ? t("devform.community.keep") : undefined}
            onChange={(e) => set("community", e.target.value)}
          />
        ) : (
          <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-3">
            <legend className="px-1 text-xs text-muted">SNMPv3</legend>
            <Field
              id="dev-v3user"
              label={t("devform.v3user")}
              autoComplete="off"
              value={values.v3_username}
              error={errors.v3_username}
              onChange={(e) => set("v3_username", e.target.value)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                id="dev-v3auth"
                label={t("devform.v3authProto")}
                value={values.v3_auth_protocol}
                error={errors.v3_auth_protocol}
                onChange={(e) => set("v3_auth_protocol", e.target.value as DeviceFormValues["v3_auth_protocol"])}
              >
                <option value="">{t("devform.none")}</option>
                {AUTH_PROTOCOLS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
              <Field
                id="dev-v3authkey"
                label={t("devform.v3authKey")}
                type="password"
                autoComplete="new-password"
                value={values.v3_auth_key}
                error={errors.v3_auth_key}
                hint={editing ? t("devform.secret.keep") : undefined}
                onChange={(e) => set("v3_auth_key", e.target.value)}
              />
              <Select
                id="dev-v3priv"
                label={t("devform.v3privProto")}
                value={values.v3_priv_protocol}
                error={errors.v3_priv_protocol}
                onChange={(e) => set("v3_priv_protocol", e.target.value as DeviceFormValues["v3_priv_protocol"])}
              >
                <option value="">{t("devform.none")}</option>
                {PRIV_PROTOCOLS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
              <Field
                id="dev-v3privkey"
                label={t("devform.v3privKey")}
                type="password"
                autoComplete="new-password"
                value={values.v3_priv_key}
                error={errors.v3_priv_key}
                hint={editing ? t("devform.secret.keep") : undefined}
                onChange={(e) => set("v3_priv_key", e.target.value)}
              />
            </div>
            <Field
              id="dev-v3ctx"
              label={t("devform.v3context")}
              autoComplete="off"
              value={values.v3_context}
              onChange={(e) => set("v3_context", e.target.value)}
            />
            <p className="text-xs text-muted">{t("devform.v3hint")}</p>
          </fieldset>
        )}

        {probeResult && <ProbeSummary result={probeResult} />}
        {probe.error && <ErrorNote>{errorMessage(probe.error)}</ErrorNote>}
        {save.error && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
        {note && (
          <p role="status" className="text-sm text-text-2">
            {note}
          </p>
        )}
        {!editing && !probe.error && !save.error && !probeResult && (
          <p className="text-xs text-muted">{t("devform.testFirst")}</p>
        )}
      </form>
  );

  if (inline) {
    return (
      <Card className="p-4 sm:p-5">
        {form}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">{footer}</div>
      </Card>
    );
  }
  return (
    <Dialog title={editing ? t("devform.title.edit", { name: device.name }) : t("devform.title.add")} onClose={onClose} footer={footer}>
      {form}
    </Dialog>
  );
}
