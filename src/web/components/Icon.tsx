import type { SVGProps } from "react";

export type IconName =
  | "archive"
  | "arrow"
  | "back"
  | "check"
  | "chevron"
  | "close"
  | "database"
  | "download"
  | "edit"
  | "folder"
  | "menu"
  | "more"
  | "note"
  | "plus"
  | "search"
  | "target"
  | "upload";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 20, ...props }: IconProps) {
  const paths: Record<IconName, React.ReactNode> = {
    archive: <><path d="M4 8h16M5 8l1-4h12l1 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1Z"/><path d="M9 12h6"/></>,
    arrow: <><path d="M5 12h13"/><path d="m14 7 5 5-5 5"/></>,
    back: <><path d="m15 18-6-6 6-6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
    database: <><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"/></>,
    download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
    edit: <><path d="m14 5 5 5L8 21H3v-5Z"/><path d="m12 7 5 5"/></>,
    folder: <><path d="M3 6h7l2 2h9v11H3Z"/><path d="M3 10h18"/></>,
    menu: <><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
    note: <><path d="M5 3h10l4 4v14H5Z"/><path d="M15 3v5h5"/><path d="M9 13h6M9 17h5"/></>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></>,
    upload: <><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></>,
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

