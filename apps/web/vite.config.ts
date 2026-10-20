import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/** Servidor de la API en desarrollo (bun run dev --cwd apps/server). */
const API = process.env.API_URL ?? "http://localhost:3000"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
        // Better Auth valida el origen: en desarrollo el navegador habla con Vite (5173), así
        // que se presenta con el origen del servidor.
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => req.setHeader("origin", API))
        },
      },
    },
  },
  // El objetivo del plan es < 250 KB gzip de JS inicial; el aviso de Vite mide sin comprimir.
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 800 },
})
