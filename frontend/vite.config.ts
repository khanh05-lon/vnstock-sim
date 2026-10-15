import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// VSS_API: địa chỉ backend để proxy (mặc định :4000) — tiện chạy song song một backend khác
const api = process.env.VSS_API || 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.VSS_WEB_PORT) || 5173,
    proxy: {
      '/api': api,
      '/socket.io': { target: api, ws: true },
    },
  },
});
