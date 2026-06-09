/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // Placeholder brand token (matches the splash color). Sync the full
        // palette from the portal's Tailwind design tokens as screens are built.
        brand: { DEFAULT: '#208AEF' },
      },
    },
  },
  plugins: [],
};
