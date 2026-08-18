import {defineConfig} from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        environmentOptions: {jsdom: {url: 'http://localhost'}},
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: ['./src/test/setup.ts'],
        // Vitest's own default is 5s, which these tests only ever cleared because they had the
        // machine to themselves. `npm run check` now runs them beside six Godot editors, and the
        // longest of them — a form filled a keystroke at a time through `userEvent` — timed out
        // there while passing every time it was run alone. None of them assert how long anything
        // takes, so the timeout is only here to catch a hang, and 15s catches a hang just as well.
        testTimeout: 15_000,
        coverage: {
            provider: 'v8',
            // No `all`: Vitest 4 removed it, and reports every file matching `include` whether a
            // test touched it or not, which is what `all` used to ask for.
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
