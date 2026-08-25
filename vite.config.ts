import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/index.ts',
        onstart(args) {
          args.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            minify: false,
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
      preload: {
        input: path.join(__dirname, 'src/preload/index.ts'),
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            minify: false
          }
        }
      },
      renderer: process.env.NODE_ENV === 'test' ? undefined : {}
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer/src')
    }
  }
})
