import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, LlmSettings } from "../api/client";
import { useAuth } from "../auth/AuthProvider";

interface LlmState {
  settings: LlmSettings | null;
  loading: boolean;
  enabled: boolean; // an active provider is set (real or demo) → show Justify
  refresh: () => Promise<void>;
  setSettings: (s: LlmSettings) => void;
}

const LlmContext = createContext<LlmState | null>(null);

export function useLlm(): LlmState {
  const ctx = useContext(LlmContext);
  if (!ctx) throw new Error("useLlm must be used within <LlmProvider>");
  return ctx;
}

export function LlmProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setSettings(null);
      return;
    }
    setLoading(true);
    try {
      setSettings(await api.getSettings());
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enabled = Boolean(settings?.activeProvider);

  return (
    <LlmContext.Provider value={{ settings, loading, enabled, refresh, setSettings }}>
      {children}
    </LlmContext.Provider>
  );
}
