import { serviceProblem } from "../components/widgets/ServerDetails";

const svc = (active: string, watched?: boolean | null) => ({ name: "x.service", active, sub: null, watched });

describe("Usługi systemd na karcie serwera", () => {
  it("problem to błąd, brak usługi albo zatrzymana obserwowana – nie zmiana stanu", () => {
    expect(serviceProblem(svc("failed", false))).toBe(true);
    expect(serviceProblem(svc("missing", true))).toBe(true);
    expect(serviceProblem(svc("inactive", true))).toBe(true);
    expect(serviceProblem(svc("active", false))).toBe(false);
    // od 0.29.0 agent wysyła wszystkie działające – start i przeładowanie to nie problem
    expect(serviceProblem(svc("activating", false))).toBe(false);
    expect(serviceProblem(svc("reloading", true))).toBe(false);
    expect(serviceProblem(svc("deactivating", false))).toBe(false);
  });

  it("starszy agent bez pola watched: jego zatrzymane usługi to obserwowane, więc problem", () => {
    expect(serviceProblem(svc("inactive"))).toBe(true);
    expect(serviceProblem(svc("inactive", null))).toBe(true);
  });
});
