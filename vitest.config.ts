import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {defineConfig} from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        environmentOptions: {jsdom: {url: 'http://localhost'}},
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: ['./src/test/setup.ts'],
        testTimeout: 15_000,
        coverage: {
            provider: 'v8',
            reportsDirectory: join(tmpdir(), 'gofer-vitest-coverage'),
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/main.tsx', 'src/test/**', 'src/theme/gofer.js', 'src/**/*.d.ts'],
            reporter: ['text'],
            thresholds: {lines: 88, branches: 80}
        }
    }
})
