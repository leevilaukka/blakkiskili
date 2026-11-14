import adapter from "@sveltejs/adapter-static";
import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// In development the app runs on :5173 and forwards /api to the bot's web server. Set
// WEB_ORIGIN=http://localhost:5173 in the bot's .env so its same-origin check accepts the browser.
export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      // A single-page app: the bot's web server answers every route with index.html (src/web/static.ts).
      adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", strict: false }),
    }),
  ],
  // Chromecast and TV browsers run old Chromium (the cast receiver page crashed on `??=`): compile down.
  build: { target: ["chrome68", "safari12"] },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8081" },
    fs: { allow: [".."] },
  },
});
