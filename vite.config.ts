import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function hostnameFrom(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

const devHost = hostnameFrom(process.env.APP_BASE_URL);
const allowedHosts = ["dev.jbat.ch", ...(devHost && devHost !== "localhost" ? [devHost] : [])];

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.DEV_CLIENT_PORT ?? 3000),
    strictPort: true,
    allowedHosts,
    proxy: {
      "/api": "http://localhost:8080",
      "/f": "http://localhost:8080",
      "/d": "http://localhost:8080",
      "/p": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
      "/readyz": "http://localhost:8080",
      "/share": "http://localhost:8080"
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
