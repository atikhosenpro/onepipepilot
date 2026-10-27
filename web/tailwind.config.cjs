/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [__dirname + '/index.html', __dirname + '/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 50: '#f4f6f8', 100: '#e6eaef', 200: '#cdd5de', 300: '#a8b4c3', 400: '#7a8aa0', 500: '#566882', 600: '#41506a', 700: '#323f55', 800: '#252f41', 900: '#1a2232', 950: '#111826' },
        reel: { 50: '#eefaf8', 100: '#d5f2ee', 200: '#aee5de', 300: '#7bd1c8', 400: '#47b7ad', 500: '#2a9b92', 600: '#1f7d77', 700: '#1d6561', 800: '#1c5150', 900: '#1b4443' },
      },
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', '-apple-system', 'Roboto', 'sans-serif'],
        display: ['"Segoe UI Variable Display"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      boxShadow: { panel: '0 1px 2px rgba(17,24,38,.06), 0 4px 14px -6px rgba(17,24,38,.10)' },
    },
  },
  plugins: [],
};
