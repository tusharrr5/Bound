/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: '#0B0D10',
        panel: '#14181F',
        hairline: '#262B33',
        paper: '#ECEEF0',
        muted: '#8A93A0',
        'signal-amber': '#F2A93B',
        'signal-green': '#3ED598',
        'signal-rose': '#FF5C72',
        'wire-blue': '#5B8DEF',
      },
      fontFamily: {
        // Web fonts load from Google; the system fallbacks keep the demo readable with wifi off
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        body: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
