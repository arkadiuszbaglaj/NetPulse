import { normalize, score, searchPalette, type PaletteItem } from "./palette";

const ITEMS: PaletteItem[] = [
  { id: "page:/", group: "pages", label: "Dashboard", to: "/" },
  { id: "page:/settings/wan", group: "pages", label: "Łącza WAN", detail: "Ustawienia", to: "/settings/wan" },
  { id: "device:1", group: "devices", label: "UCG Ultra", detail: "192.168.1.1 · Router", to: "/devices/1" },
  { id: "device:2", group: "devices", label: "USW Lite 8 PoE", detail: "192.168.1.2 · Switch", to: "/devices/2" },
  { id: "port:7", group: "ports", label: "Telewizor", detail: "USW Lite 8 PoE", keywords: "0/7", to: "/devices/2/ports/7" },
  { id: "client:aa", group: "clients", label: "Laptop Arka", detail: "192.168.1.50 · Dom", keywords: "aa:bb:cc:dd:ee:ff", to: "/clients/aa" },
];

describe("paleta poleceń", () => {
  it("porównuje bez polskich znaków i wielkości liter", () => {
    expect(normalize("  Łącza WAN ")).toBe("lacza wan");
    expect(searchPalette(ITEMS, "lacza").map((i) => i.id)).toEqual(["page:/settings/wan"]);
  });

  it("każde słowo zapytania musi pasować; szuka też w opisie i słowach kluczowych", () => {
    expect(searchPalette(ITEMS, "usw 192").map((i) => i.id)).toEqual(["device:2"]);
    expect(searchPalette(ITEMS, "usw 10.0")).toEqual([]);
    expect(searchPalette(ITEMS, "ee:ff").map((i) => i.id)).toEqual(["client:aa"]);
    expect(searchPalette(ITEMS, "0/7").map((i) => i.id)).toEqual(["port:7"]);
  });

  it("początek nazwy wygrywa ze środkiem i z opisem", () => {
    const words = ["u"];
    expect(score(ITEMS[2], words)).toBeGreaterThan(score(ITEMS[4], words)); // „UCG…” > „…USW…” w opisie portu
    expect(score(ITEMS[0], ["zzz"])).toBe(0);
  });

  it("wyniki w kolejności grup: strony, urządzenia, porty, klienci", () => {
    expect(searchPalette(ITEMS, "o").map((i) => i.group)).toEqual(["pages", "devices", "devices", "ports", "clients"]);
  });

  it("puste zapytanie pokazuje strony i urządzenia", () => {
    expect(searchPalette(ITEMS, "").map((i) => i.id)).toEqual(["page:/", "page:/settings/wan", "device:1", "device:2"]);
  });

  it("limit wyników na grupę", () => {
    const many = Array.from({ length: 20 }, (_, i): PaletteItem => ({ id: `d${i}`, group: "devices", label: `Switch ${i}`, to: `/devices/${i}` }));
    expect(searchPalette(many, "switch")).toHaveLength(6);
  });
});
