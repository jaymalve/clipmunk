import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import { FlickStudioHost } from "./flick/Studio";

createRoot(document.getElementById("root")!).render(
  <FlickStudioHost>
    <StrictMode>
      <App />
    </StrictMode>
  </FlickStudioHost>,
);
