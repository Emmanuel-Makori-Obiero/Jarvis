import { HashRouter, Routes, Route } from "react-router-dom";
import Assistant from "./pages/Assistant";
import Download from "./pages/Download";

const isElectron = navigator.userAgent.toLowerCase().includes("electron");

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={isElectron ? <Assistant /> : <Download />} />
        <Route path="/download" element={<Download />} />
        <Route path="/app" element={<Assistant />} />
      </Routes>
    </HashRouter>
  );
}
