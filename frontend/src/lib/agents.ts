/** Agenci serwerów Linux (API: backend/netpulse/api/agents.py). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { useRefresh } from "./refresh";

export interface Agent {
  id: number;
  device_id: number;
  name: string;
  enabled: boolean;
  status: string;
  token_hint: string;
  created_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  agent_version: string | null;
  hostname: string | null;
}

/** Odpowiedź na dodanie agenta albo nowy token – token jest widoczny tylko tutaj, raz. */
export interface AgentToken {
  agent: Agent;
  token: string;
}

export const AGENTS_KEY = ["agents"];

export function useAgents() {
  const { refetchInterval } = useRefresh();
  return useQuery({ queryKey: AGENTS_KEY, queryFn: () => get<Agent[]>("/api/agents"), refetchInterval });
}

/** Polecenie do wklejenia na monitorowanym serwerze. Adres NetPulse = adres, pod którym działa panel. */
export function installCommand(origin: string, token: string): string {
  return `curl -fsSL ${origin}/agent/install.sh | sudo bash -s -- --url ${origin} --token ${token}`;
}

export function uninstallCommand(origin: string): string {
  return `curl -fsSL ${origin}/agent/install.sh | sudo bash -s -- --uninstall`;
}
