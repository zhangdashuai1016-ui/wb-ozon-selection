import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allocatedTestPorts } from '../helpers/api-process-lifecycle.mjs';

const { api, second } = allocatedTestPorts();
const browserOrigin = `http://127.0.0.1:${second}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: second, strictPort: true,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:", `connect-src 'self' ${browserOrigin.replace('http:', 'ws:')}`,
        "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"
      ].join('; ')
    },
    proxy: {
      '/api': `http://127.0.0.1:${api}`,
      '/product-images': `http://127.0.0.1:${api}`
    }
  }
});
