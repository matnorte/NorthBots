import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n/index.js";
import "./index.css";
import "./workspace.css";
import { App } from "./App.js";
import { installNativeShell } from "./native.js";

installNativeShell();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
