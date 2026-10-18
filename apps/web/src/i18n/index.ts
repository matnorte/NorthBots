import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en.js";
import { es } from "./es.js";
import { ptBR } from "./pt-BR.js";

export const resources = {
  en: { translation: en },
  "pt-BR": { translation: ptBR },
  es: { translation: es },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: navigator.language in resources ? navigator.language : "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
