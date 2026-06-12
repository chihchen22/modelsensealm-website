/** Static compile config for the hand-authored site (replaces the Tailwind Play CDN).
 *  Rebuild after editing build/index.html or build/404.html:
 *  npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i tw-input.css -o build/assets/site.css --minify
 */
module.exports = {
  content: ["./build/index.html", "./build/404.html"],
  theme: {
    extend: {
      colors: {
        "cloud-dancer": "#F6F6F4",
        "obsidian": "#121312",
        "sand": "#D1CBC1",
        "node-teal": "#2B7A78",
        "node-green": "#3D7A42",
        "node-orange": "#C86A3A",
        "node-purple": "#7050A0",
      },
      fontFamily: {
        sans: ["Sora", "sans-serif"],
        serif: ["Playfair Display", "serif"],
      },
      animation: {
        "fade-in-up": "fadeInUp 1s ease-out forwards",
      },
      keyframes: {
        fadeInUp: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
};
