/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: { sans: ["Nunito", "ui-rounded", "system-ui", "sans-serif"] },
      colors: {
        cream: "#fff8ef",
        peach: "#ffd9c2",
        mint: "#cdeee0",
        sky: "#cfe6ff",
        lilac: "#e4d8ff",
        ink: "#3b3550",
        accent: "#ff7a59",
        evening: "#26223a",
      },
      borderRadius: { blob: "1.5rem" },
      boxShadow: { soft: "0 6px 20px rgba(59, 53, 80, 0.12)" },
      transitionTimingFunction: { squish: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    },
  },
  plugins: [],
};
