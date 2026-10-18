import type { CSSProperties } from "react";

const paths = {
  security: "M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Zm-3-10 2 2 4-4",
  companion: "M2 4h20v12H2V4Zm6 16h8m-4-4v4M9 9l2 2 4-4",
  operations: "M3 12h4l3-8 4 16 3-8h4",
  schedules: "M3 5h18v16H3V5Zm4-3v6m10-6v6M3 11h18m-13 4h1m3 0h1m3 0h1m-9 3h1m3 0h1",
  agents:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-7.87a4 4 0 0 1 0 7.75",
  office: "M3 21h18M5 21V5l7-3 7 3v16M9 7h1m4 0h1M9 11h1m4 0h1M10 21v-6h4v6",
  approvals: "m9 12 2 2 4-4M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z",
  rooms:
    "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  letters: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm18 2-10 7L2 6",
  talks: "M3 3h18v12H3V3Zm9 12v7m-5 0 5-4 5 4M7 11l3-3 3 2 4-4",
  ideas: "M9 18h6m-5 4h4M8.1 14a6 6 0 1 1 7.8 0c-.9.7-1.4 1.5-1.4 2.5h-5c0-1-.5-1.8-1.4-2.5Z",
  memory:
    "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2ZM8 7h8m-8 4h5",
  skills: "m12 3 2.8 5.7L21 9.6l-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9L7.5 14 3 9.6l6.2-.9L12 3Z",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3l-1 3-3 1-2 3 2 2-1 3 3 2 1 3h4l1-3 3-1 3-3-2-2 1-3-3-2-1-3H9Z",
  search: "m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  computer: "M3 3h18v14H3V3Zm4 18h10m-5-4v4",
  grid: "M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  close: "m6 6 12 12M6 18 18 6",
  logout: "M9 21H3V3h6m7 4 5 5-5 5M7 12h14",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0",
  menu: "M3 6h18M3 12h18M3 18h18",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  clock: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
