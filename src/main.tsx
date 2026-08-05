import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { LlmProvider } from "./llm/LlmProvider";
import { LanguageProvider } from "./i18n/LanguageProvider";
import { TranslationProvider } from "./i18n/TranslationProvider";
import { AstroChatProvider } from "./chat/AstroChat";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <LlmProvider>
        <LanguageProvider>
          <TranslationProvider>
            <AstroChatProvider>
              <App />
            </AstroChatProvider>
          </TranslationProvider>
        </LanguageProvider>
      </LlmProvider>
    </AuthProvider>
  </React.StrictMode>,
);
