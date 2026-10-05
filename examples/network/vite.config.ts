import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        network: 'index.html',
        colors: 'colors.html',
        coupled: 'coupled.html',
        bunny: 'bunny.html',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5188,
    open: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 5188,
  },
});
