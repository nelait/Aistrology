import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_LANGUAGE, Language, languageByCode } from "./languages";

interface LanguageState {
  language: Language;
  setLanguageCode: (code: string) => void;
  isEnglish: boolean;
}

const LanguageContext = createContext<LanguageState | null>(null);
const STORAGE_KEY = "aistro_lang";

export function useLanguage(): LanguageState {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within <LanguageProvider>");
  return ctx;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [code, setCode] = useState<string>(() => {
    return (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || DEFAULT_LANGUAGE;
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      /* ignore */
    }
  }, [code]);

  const language = languageByCode(code);
  return (
    <LanguageContext.Provider
      value={{ language, setLanguageCode: setCode, isEnglish: language.code === "en" }}
    >
      {children}
    </LanguageContext.Provider>
  );
}
