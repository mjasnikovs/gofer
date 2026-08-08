import {defineConfig} from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        environmentOptions: {jsdom: {url: 'http://localhost'}},
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: ['./src/test/setup.ts'],
        coverage: {
            provider: 'v8',
            all: true,
            include: ['src/**/*.{ts,tsx}'],
            // Excluded because none of it is production code the tests can cover: the entry point
            // mounts the real app, `src/test` is the harness itself, `theme/gofer.js` is generated
            // from the Astryx tokens, and the `.d.ts` files declare types that erase at build.
            exclude: ['src/main.tsx', 'src/test/**', 'src/theme/gofer.js', 'src/**/*.d.ts'],
            reporter: ['text'],
            thresholds: {lines: 88, branches: 80}
        }
    }
})
