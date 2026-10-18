/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"] },
      // Dark theme: blacks and grays, with rainbow accents (see .bg-rainbow / .text-rainbow in index.css).
      // Agent avatar colours are separate (packages/shared COLOR_HEX) and stay vivid.
      colors: {
        cream: "#101114", // page background
        panel: "#181a1f", // cards and menus
        peach: "#202228", // raised surfaces
        mint: "#22262c",
        sky: "#292d35",
        lilac: "#2c2d39",
        butter: "#343640",
        line: "#30333b",
        ink: "#eeeff3",
        muted: "#a0a4b0",
        accent: "#ff6b8b", // errors and warnings
        evening: "#0b0b0e",
      },
      borderRadius: { blob: "0.875rem" },
      boxShadow: { soft: "0 2px 8px rgba(0, 0, 0, 0.12)" },
      transitionTimingFunction: { squish: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    },
  },
  plugins: [],
};
