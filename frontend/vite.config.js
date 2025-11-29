// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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

    }
  }
});
