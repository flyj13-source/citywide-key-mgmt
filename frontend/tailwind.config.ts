import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'cw-red': '#C0272D',
        'cw-black': '#1a1a1a',
        'cw-bg': '#f4f4f2',
        'cw-card': '#ffffff',
        'cw-border': '#e0e0dd',
        'cw-text': '#1a1a1a',
        'cw-muted': '#6b6b68',
      },
      fontFamily: {
        sans: ['system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
