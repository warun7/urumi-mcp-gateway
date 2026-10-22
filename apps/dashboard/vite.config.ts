import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In the cluster, the Ingress puts the dashboard and the gateway on one origin. In dev, Vite proxies the
// gateway paths so cookies and the CSRF Origin check behave the same way (add http://localhost:5173 to
// the gateway's EXTRA_ALLOWED_ORIGINS).
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const proxy = Object.fromEntries(['/api', '/mcp', '/oauth', '/.well-known'].map((p) => [p, { target: gateway, changeOrigin: false }]));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 800 },
});
