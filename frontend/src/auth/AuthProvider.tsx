import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { get, post, type AuthStatus, type User } from "../lib/api";

export const AUTH_KEY = ["auth", "status"] as const;

interface AuthContextValue {
  status: AuthStatus | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: AUTH_KEY,
    queryFn: () => get<AuthStatus>("/api/auth/status"),
    staleTime: 60_000,
    retry: false,
  });

  const logoutMutation = useMutation({
    mutationFn: () => post<void>("/api/auth/logout"),
    // Po wylogowaniu nic z poprzedniej sesji nie zostaje w pamięci podręcznej
    onSettled: async () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_KEY[0] });
      await qc.invalidateQueries({ queryKey: AUTH_KEY });
    },
  });

  const value: AuthContextValue = {
    status: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
    logout: () => logoutMutation.mutateAsync(),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth poza AuthProvider");
  return ctx;
}

/** Zalogowany użytkownik – tylko dla widoków za bramką logowania. */
export function useUser(): User {
  const user = useAuth().status?.user;
  if (!user) throw new Error("useUser bez zalogowanego użytkownika");
  return user;
}
