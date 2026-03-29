import { useEffect, useState } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import Layout from "./Layout";
import Dashboard from "./pages/Dashboard";
import Whitelist from "./pages/Whitelist";
import Settings from "./pages/Settings";
import Projects from "./pages/Projects";
import AccessibilityModal from "./components/AccessibilityModal";
import { checkAccessibility } from "./api";

export default function App() {
  const [needsAccessibility, setNeedsAccessibility] = useState(false);

  useEffect(() => {
    checkAccessibility().then((granted) => {
      if (!granted) setNeedsAccessibility(true);
    });
  }, []);

  return (
    <>
      {needsAccessibility && (
        <AccessibilityModal onDismiss={() => setNeedsAccessibility(false)} />
      )}
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="projects" element={<Projects />} />
            <Route path="whitelist" element={<Whitelist />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </HashRouter>
    </>
  );
}
