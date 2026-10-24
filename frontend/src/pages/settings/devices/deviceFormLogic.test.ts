import type { Device } from "../../../lib/api";
import { DEVICE } from "../../../test/mockApi";
import {
  buildCreate,
  buildPatch,
  buildTarget,
  emptyForm,
  formFromDevice,
  isEmptyPatch,
  isValidHost,
  parsePort,
  validate,
  type DeviceFormValues,
} from "./deviceFormLogic";

const filled = (over: Partial<DeviceFormValues> = {}): DeviceFormValues => ({
  ...emptyForm(),
  name: "Switch",
  host: "192.168.1.2",
  ...over,
});

const v3Device: Device = {
  ...DEVICE,
  snmp_version: "3",
  v3_username: "monitor",
  v3_auth_protocol: "SHA",
  v3_priv_protocol: "AES",
  v3_context: null,
};

describe("host i port", () => {
  it("rozpoznaje adresy IP i nazwy hostów", () => {
    for (const ok of ["192.168.1.1", "switch", "switch.lan", "nas-1.home.arpa", "fe80::1", " 10.0.0.2 "]) {
      expect(isValidHost(ok), ok).toBe(true);
    }
    for (const bad of ["", "nie ma; takiego", "-zly.host", "a..b", "host_z_podkreslnikiem"]) {
      expect(isValidHost(bad), bad).toBe(false);
    }
  });

  it("port to liczba 1–65535", () => {
    expect(parsePort("161")).toBe(161);
    expect(parsePort("65535")).toBe(65535);
    for (const bad of ["", "0", "65536", "abc", "-1", "16.1"]) expect(parsePort(bad), bad).toBeNull();
  });
});

describe("validate – dodawanie", () => {
  it("poprawny formularz v2c nie ma błędów", () => {
    expect(validate(filled())).toEqual({});
  });

  it("wymaga nazwy, hosta, portu i community", () => {
    const e = validate(filled({ name: " ", host: "", port: "0", community: "" }));
    expect(Object.keys(e).sort()).toEqual(["community", "host", "name", "port"]);
  });

  it("SNMPv3 wymaga użytkownika i kluczy do wybranych protokołów", () => {
    expect(validate(filled({ snmp_version: "3" }))).toEqual({ v3_username: expect.any(String) });
    const e = validate(filled({ snmp_version: "3", v3_username: "mon", v3_auth_protocol: "SHA", v3_priv_protocol: "AES" }));
    expect(Object.keys(e).sort()).toEqual(["v3_auth_key", "v3_priv_key"]);
  });

  it("SNMPv3: klucze min. 8 znaków, szyfrowanie wymaga uwierzytelniania, klucz wymaga protokołu", () => {
    expect(validate(filled({ snmp_version: "3", v3_username: "m", v3_auth_protocol: "SHA", v3_auth_key: "krotki" })).v3_auth_key).toBeDefined();
    expect(validate(filled({ snmp_version: "3", v3_username: "m", v3_priv_protocol: "AES", v3_priv_key: "dlugiklucz1" })).v3_priv_protocol).toBeDefined();
    expect(validate(filled({ snmp_version: "3", v3_username: "m", v3_auth_key: "dlugiklucz1" })).v3_auth_protocol).toBeDefined();
    const ok = filled({
      snmp_version: "3",
      v3_username: "m",
      v3_auth_protocol: "SHA",
      v3_auth_key: "authklucz1",
      v3_priv_protocol: "AES",
      v3_priv_key: "privklucz1",
    });
    expect(validate(ok)).toEqual({});
  });

  it("SNMPv3 bez protokołów (noAuthNoPriv) jest dozwolone", () => {
    expect(validate(filled({ snmp_version: "3", v3_username: "mon" }))).toEqual({});
  });
});

describe("validate – edycja", () => {
  it("puste community przy v2c oznacza „bez zmian”", () => {
    expect(validate(formFromDevice(DEVICE), DEVICE)).toEqual({});
  });

  it("zmiana z v3 na v2c wymaga community, bo żadnego nie ma w bazie", () => {
    expect(validate({ ...formFromDevice(v3Device), snmp_version: "2c" }, v3Device).community).toBeDefined();
  });

  it("zmiana z v2c na v1 nie wymaga ponownego wpisywania community", () => {
    expect(validate({ ...formFromDevice(DEVICE), snmp_version: "1" }, DEVICE)).toEqual({});
  });

  it("zmiana z v2c na v3 wymaga użytkownika", () => {
    expect(validate({ ...formFromDevice(DEVICE), snmp_version: "3" }, DEVICE).v3_username).toBeDefined();
  });

  it("v3 z zapisanymi kluczami: puste klucze = bez zmian, ale nowy protokół wymaga klucza", () => {
    expect(validate(formFromDevice(v3Device), v3Device)).toEqual({});
    const changed = { ...formFromDevice(v3Device), v3_auth_protocol: "SHA256" as const };
    expect(validate(changed, v3Device).v3_auth_key).toBeDefined();
    expect(validate({ ...changed, v3_auth_key: "nowyklucz12" }, v3Device)).toEqual({});
  });
});

describe("budowanie żądań", () => {
  it("buildTarget v2c pomija pola SNMPv3", () => {
    expect(buildTarget(filled({ v3_username: "zostaje-w-formularzu" }))).toEqual({
      host: "192.168.1.2",
      port: 161,
      driver: "auto",
      snmp_version: "2c",
      community: "public",
    });
  });

  it("buildTarget v3 pomija community i puste pola", () => {
    const target = buildTarget(
      filled({ snmp_version: "3", community: "public", v3_username: " mon ", v3_auth_protocol: "SHA", v3_auth_key: "authklucz1" }),
    );
    expect(target).toEqual({
      host: "192.168.1.2",
      port: 161,
      driver: "auto",
      snmp_version: "3",
      v3_username: "mon",
      v3_auth_protocol: "SHA",
      v3_auth_key: "authklucz1",
    });
  });

  it("buildCreate dodaje nazwę", () => {
    expect(buildCreate(filled({ name: " Switch " })).name).toBe("Switch");
  });

  it("buildPatch wysyła tylko zmienione pola; brak zmian = pusty patch", () => {
    const base = formFromDevice(DEVICE);
    expect(isEmptyPatch(buildPatch(base, DEVICE))).toBe(true);
    expect(buildPatch({ ...base, name: "Nowa nazwa" }, DEVICE)).toEqual({ name: "Nowa nazwa" });
    expect(buildPatch({ ...base, host: "10.0.0.9", port: "1161" }, DEVICE)).toEqual({ host: "10.0.0.9", port: 1161 });
  });

  it("buildPatch: community tylko gdy wpisane", () => {
    const base = formFromDevice(DEVICE);
    expect(buildPatch(base, DEVICE).community).toBeUndefined();
    expect(buildPatch({ ...base, community: "tajne" }, DEVICE).community).toBe("tajne");
  });

  it("buildPatch v3: sekrety tylko gdy wpisane, wyczyszczenie protokołu czyści też klucz", () => {
    const base = formFromDevice(v3Device);
    expect(isEmptyPatch(buildPatch(base, v3Device))).toBe(true);
    expect(buildPatch({ ...base, v3_auth_key: "nowyklucz12" }, v3Device)).toEqual({ v3_auth_key: "nowyklucz12" });
    expect(buildPatch({ ...base, v3_priv_protocol: "" }, v3Device)).toEqual({ v3_priv_protocol: null, v3_priv_key: null });
    expect(buildPatch({ ...base, v3_auth_protocol: "SHA256", v3_auth_key: "nowyklucz12" }, v3Device)).toEqual({
      v3_auth_protocol: "SHA256",
      v3_auth_key: "nowyklucz12",
    });
  });
});
