import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Download from "./pages/Download";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/download" element={<Download />} />
      </Routes>
    </BrowserRouter>
  );
}
