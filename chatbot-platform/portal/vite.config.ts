import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@pages': path.resolve(__dirname, './src/pages'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@context': path.resolve(__dirname, './src/context'),
      '@app-types': path.resolve(__dirname, './src/types'),
      '@services': path.resolve(__dirname, './src/services'),
      '@config': path.resolve(__dirname, './src/config'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@auth': path.resolve(__dirname, './src/auth'),
      '@websocket': path.resolve(__dirname, './src/websocket'),
      '@clerk/shared': path.resolve(__dirname, 'node_modules/@clerk/shared'),
    },
    dedupe: ['@clerk/shared', '@clerk/clerk-react', 'react', 'react-dom'],
  },
  server: {
    port: 4080,
    proxy: {
      '/api': {
        target: 'http://localhost:4081',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:4081',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
