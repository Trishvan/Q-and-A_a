// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, // dev server port (change if you like)
    proxy: {
      // Proxy any request starting with /ask to your backend
      "/ask": {
        target: "http://localhost:5000", // your Express backend
        changeOrigin: true,
        secure: false,    // set true if backend uses valid HTTPS cert
        ws: false,        // set true only if you proxy websockets
        rewrite: (path) => path.replace(/^\/ask/, "/ask"), // identity rewrite (keeps path)
      },

      // OPTIONAL: If you also call other API paths (e.g. /api), add them here:
      // "/api": { target: "http://localhost:5000", changeOrigin: true, secure: false }
    }
  }
});
