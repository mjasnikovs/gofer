import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

const {TAURI_DEV_HOST: host} = process.env

export default defineConfig(() => ({
    plugins: [react()],

    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: host ?? false,
        ...(host && {hmr: {protocol: 'ws', host, port: 1421}}),
        watch: {
            ignored: ['**/src-tauri/**']
        }
    }
}))
