/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0a0a0a",
          soft: "#1a1a1a",
          muted: "#71717a",
        },
        brand: {
          50: "#fef9ee",
          100: "#fdf0d6",
          200: "#fadeac",
          500: "#c89148",
          600: "#a97432",
          700: "#8a5d2a",
          900: "#4a3215",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-inter)",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        display: [
          "var(--font-display)",
          "Playfair Display",
          "Georgia",
          "ui-serif",
          "serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.04), 0 6px 18px -8px rgba(10,10,10,0.12)",
        ring: "0 0 0 1px rgba(200,145,72,0.5), 0 0 0 4px rgba(200,145,72,0.12)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
