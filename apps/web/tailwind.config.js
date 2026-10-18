/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Nunito", "ui-rounded", "system-ui", "sans-serif"] },
      // Dark theme: blacks and grays, with rainbow accents (see .bg-rainbow / .text-rainbow in index.css).
      // Agent avatar colours are separate (packages/shared COLOR_HEX) and stay vivid.
      colors: {
        cream: "#0b0b0e", // page background
        panel: "#141418", // cards and menus
        peach: "#1c1c22", // surfaces, from darkest...
        mint: "#202027",
        sky: "#25252d",
        lilac: "#2b2b34",
        butter: "#31313b", // ...to lightest
        line: "#33333d", // borders
        ink: "#e9e9ee", // text
        muted: "#9a9aa8", // secondary text
        accent: "#ff6b8b", // errors and warnings
        evening: "#0b0b0e",
      },
      borderRadius: { blob: "1.5rem" },
      boxShadow: { soft: "0 6px 20px rgba(0, 0, 0, 0.45)" },
      transitionTimingFunction: { squish: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    },
  },
  plugins: [],
};
