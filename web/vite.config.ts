import { defineConfig } from "vite";

// base "./" so the built app works from any folder (and as a hosted preview)
// /api goes to the Stage 3 backend (uvicorn server.app:app --port 8000)
export default defineConfig({
  base: "./",
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
});
