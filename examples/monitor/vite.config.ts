import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5190,
    open: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 5190,
  },
});
