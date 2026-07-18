import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        panel: "0 12px 35px rgba(0, 0, 0, 0.35)"
      }
    }
  },
  plugins: []
};

export default config;
