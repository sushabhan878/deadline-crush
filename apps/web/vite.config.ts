import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: process.env.DC_API_PROXY ?? 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } } },
});
