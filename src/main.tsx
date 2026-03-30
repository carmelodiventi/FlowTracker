import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n"; // initialise i18next before the app renders
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
