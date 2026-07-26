import { HashRouter, Routes, Route } from "react-router-dom";
import Assistant from "./pages/Assistant";
import Download from "./pages/Download";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Assistant />} />
        <Route path="/download" element={<Download />} />
      </Routes>
    </HashRouter>
  );
}
