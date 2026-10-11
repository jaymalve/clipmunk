import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import { ClipmunkStudioHost } from "./clipmunk/Studio";

createRoot(document.getElementById("root")!).render(
  <ClipmunkStudioHost>
    <StrictMode>
      <App />
    </StrictMode>
  </ClipmunkStudioHost>,
);
