import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon, type IconName } from "./Icon";

const navigation: Array<{ to: string; label: string; icon: IconName }> = [
  { to: "/", label: "Projects", icon: "folder" },
  { to: "/search", label: "Search", icon: "search" },
  { to: "/archive", label: "Archive", icon: "archive" },
];

export function AppShell() {
  const location = useLocation();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink aria-label="Istra home" className="wordmark" to="/">Istra</NavLink>
        <nav aria-label="Main navigation" className="sidebar__nav">
          {navigation.map((item) => {
            const detailSelected = item.to === "/" && location.pathname.startsWith("/projects/");
            return (
              <NavLink
                className={({ isActive }) => `nav-link${isActive || detailSelected ? " nav-link--active" : ""}`}
                end={item.to === "/"}
                key={item.to}
                to={item.to}
              >
                <Icon name={item.icon} size={22} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="sidebar__storage">
          <Icon name="database" size={21} />
          <span>Local · Synced to disk</span>
        </div>
      </aside>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

