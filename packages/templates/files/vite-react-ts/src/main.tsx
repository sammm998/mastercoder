import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { KitBody, KitProviders } from "./kit/slots";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <KitProviders>
      <App />
      <KitBody />
    </KitProviders>
  </StrictMode>,
);
