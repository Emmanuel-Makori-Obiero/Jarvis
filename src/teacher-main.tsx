import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import TeacherOverlay from "./pages/TeacherOverlay.tsx";

createRoot(document.getElementById("teacher-root")!).render(
  <StrictMode>
    <TeacherOverlay />
  </StrictMode>,
);
