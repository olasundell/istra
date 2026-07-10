import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ArchivePage } from "./features/archive/ArchivePage";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { ProjectPage } from "./features/projects/ProjectPage";
import { SearchPage } from "./features/search/SearchPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="archive" element={<ArchivePage />} />
          <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route path="*" element={<DashboardPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

