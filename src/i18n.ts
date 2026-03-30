import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { en, it, fr, es, zh, ru, ja, pt } from "./lib/i18nResources";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      it: { translation: it },
      fr: { translation: fr },
      es: { translation: es },
      zh: { translation: zh },
      ru: { translation: ru },
      ja: { translation: ja },
      pt: { translation: pt },
    },
    fallbackLng: "en",
    // i18next-browser-languagedetector will look in localStorage under
    // the key "i18nextLng" by default. The Settings page language picker
    // calls i18n.changeLanguage(code) which also persists this.
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
    interpolation: {
      escapeValue: false, // React already escapes by default
    },
  });

export default i18n;
