import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(apiPort) || apiPort <= 0) throw new Error('SIBLING_BATCH_BROWSER_API_PORT_REQUIRED');

export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1',
  proxy: { '/api': `http://127.0.0.1:${apiPort}` } } });
