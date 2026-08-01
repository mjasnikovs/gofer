import '@testing-library/jest-dom/vitest'

class ResizeObserverStub implements ResizeObserver {
    disconnect() {
        return undefined
    }
    observe() {
        return undefined
    }
    unobserve() {
        return undefined
    }
}

globalThis.ResizeObserver = ResizeObserverStub

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => null
})

Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false
    })
})
