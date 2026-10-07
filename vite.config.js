import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' keeps asset paths relative so the build works under
// https://<user>.github.io/academic-matchmaker/ on GitHub Pages.
export default defineConfig({
  plugins: [react()],
  base: './',
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
})
