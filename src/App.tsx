import { HashRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Download from "./pages/Download";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/download" element={<Download />} />
      </Routes>
    </HashRouter>
  );
}
