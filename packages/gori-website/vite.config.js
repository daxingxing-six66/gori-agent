import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 4188, strictPort: true },
  preview: { port: 4188, strictPort: true },
});
