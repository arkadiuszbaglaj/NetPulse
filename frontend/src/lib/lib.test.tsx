import { act, renderHook } from "@testing-library/react";
import { ApiError, messageFromDetail, request } from "./api";
import { formatUptime, initials, relativeTime } from "./format";
import { ThemeProvider, readPref, resolveTheme, useTheme } from "./theme";

describe("api", () => {
  it("wyciąga komunikat z tekstu i z listy błędów walidacji", () => {
    expect(messageFromDetail("Nieprawidłowy login", "x")).toBe("Nieprawidłowy login");
    expect(messageFromDetail([{ msg: "za krótkie" }, { msg: "zły format" }], "x")).toBe("za krótkie zły format");
    expect(messageFromDetail(undefined, "awaria")).toBe("awaria");
    expect(messageFromDetail([], "awaria")).toBe("awaria");
  });

  it("rzuca ApiError z kodem i komunikatem serwera", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "Wymagane logowanie" }), { status: 401 })),
    );
    await expect(request("GET", "/api/devices")).rejects.toMatchObject({ status: 401, message: "Wymagane logowanie" });
    await expect(request("GET", "/api/devices")).rejects.toBeInstanceOf(ApiError);
  });

  it("obsługuje 204 bez treści", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(request("POST", "/api/auth/logout", {})).resolves.toBeUndefined();
  });

  it("wysyła ciasteczka z tego samego źródła i JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await request("POST", "/api/x", { a: 1 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("format", () => {
  const now = new Date("2026-10-24T20:00:00Z").getTime();

  it("relativeTime", () => {
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime("2026-10-24T19:59:58Z", now)).toBe("przed chwilą");
    expect(relativeTime("2026-10-24T19:59:30Z", now)).toMatch(/30 sekund temu/);
    expect(relativeTime("2026-10-24T19:55:00Z", now)).toMatch(/5 minut temu/);
    expect(relativeTime("2026-10-24T17:00:00Z", now)).toMatch(/3 godziny temu/);
  });

  it("formatUptime", () => {
    expect(formatUptime(null)).toBe("-");
    expect(formatUptime(45 * 60)).toBe("45 min");
    expect(formatUptime(3 * 3600 + 120)).toBe("3 h 2 min");
    expect(formatUptime(45 * 86400 + 18 * 3600)).toBe("45 d 18 h");
  });

  it("initials", () => {
    expect(initials("admin")).toBe("AD");
    expect(initials("jan.kowalski")).toBe("JK");
    expect(initials("a")).toBe("A");
  });
});

describe("theme", () => {
  it("domyślnie według systemu i zapamiętuje wybór", () => {
    expect(readPref()).toBe("system");
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.pref).toBe("system");

    act(() => result.current.cycle());
    expect(result.current.pref).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("netpulse.theme")).toBe("light");

    act(() => result.current.cycle());
    expect(result.current.pref).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => result.current.cycle());
    expect(result.current.pref).toBe("system");
  });

  it("system ciemny → motyw ciemny", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });

  it("ignoruje nieprawidłową zapamiętaną wartość", () => {
    localStorage.setItem("netpulse.theme", "fioletowy");
    expect(readPref()).toBe("system");
  });
});
