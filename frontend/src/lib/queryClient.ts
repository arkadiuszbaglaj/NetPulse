import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { AUTH_KEY } from "../auth/AuthProvider";
import { ApiError } from "./api";

/**
 * Klient zapytań z jedną regułą na całą aplikację: odpowiedź 401 (sesja wygasła albo została
 * unieważniona, np. po zmianie hasła) → sprawdź status logowania i wróć do ekranu logowania.
 */
export function createQueryClient({ retry = 1 }: { retry?: number | false } = {}): QueryClient {
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      void client.invalidateQueries({ queryKey: AUTH_KEY });
    }
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: { queries: { retry, refetchOnWindowFocus: true } },
  });
  return client;
}
