// Supported UI/translation languages. Adding another Indian language is a
// one-line change here — the selector and the LLM translation flow pick it up
// automatically (the LLM does the actual translation, keyed by `english` name).

export interface Language {
  code: string; // BCP-47-ish short code
  english: string; // name in English (sent to the LLM)
  native: string; // endonym, shown in the selector
}

export const LANGUAGES: Language[] = [
  { code: "en", english: "English", native: "English" },
  { code: "te", english: "Telugu", native: "తెలుగు" },
  { code: "ta", english: "Tamil", native: "தமிழ்" },
  { code: "hi", english: "Hindi", native: "हिन्दी" },
  // Add more here, e.g.:
  // { code: "kn", english: "Kannada", native: "ಕನ್ನಡ" },
  // { code: "ml", english: "Malayalam", native: "മലയാളം" },
  // { code: "bn", english: "Bengali", native: "বাংলা" },
];

export const DEFAULT_LANGUAGE = "en";

export function languageByCode(code: string): Language {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}
