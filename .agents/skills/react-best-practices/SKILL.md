---
name: react-best-practices
description:
    Pure React client-side performance and composition patterns. 50+ rules across 9 categories,
    prioritized by impact. Auto-activates when writing, reviewing, or refactoring React components
    in .tsx/.jsx files.
---

# React Best Practices

Apply these rules when writing, reviewing, or refactoring React components. Rules are ordered by
impact from CRITICAL to LOW. Each rule shows incorrect and correct patterns.

---

## 1. Component Architecture

**Impact: HIGH**

### 1.1 Avoid Boolean Prop Proliferation

Don't add boolean props like `isThread`, `isEditing` to customize behavior. Each boolean doubles
possible states. Use composition instead.

❌ Incorrect:

```tsx
function Composer({
    onSubmit,
    isThread,
    channelId,
    isDMThread,
    dmId,
    isEditing,
    isForwarding
}: Props) {
    return (
        <form>
            <Header />
            <Input />
            {isDMThread ?
                <AlsoSendToDMField id={dmId} />
            : isThread ?
                <AlsoSendToChannelField id={channelId} />
            :   null}
            {isEditing ?
                <EditActions />
            : isForwarding ?
                <ForwardActions />
            :   <DefaultActions />}
            <Footer onSubmit={onSubmit} />
        </form>
    )
}
```

✅ Correct — explicit variants with shared internals:

```tsx
function ChannelComposer() {
    return (
        <Composer.Frame>
            <Composer.Header />
            <Composer.Input />
            <Composer.Footer>
                <Composer.Attachments />
                <Composer.Formatting />
                <Composer.Submit />
            </Composer.Footer>
        </Composer.Frame>
    )
}

function ThreadComposer({channelId}: {channelId: string}) {
    return (
        <Composer.Frame>
            <Composer.Header />
            <Composer.Input />
            <AlsoSendToChannelField id={channelId} />
            <Composer.Footer>
                <Composer.Formatting />
                <Composer.Submit />
            </Composer.Footer>
        </Composer.Frame>
    )
}

function EditComposer() {
    return (
        <Composer.Frame>
            <Composer.Input />
            <Composer.Footer>
                <Composer.CancelEdit />
                <Composer.SaveEdit />
            </Composer.Footer>
        </Composer.Frame>
    )
}
```

### 1.2 Use Compound Components

Structure complex components as compound components with shared context. Consumers compose the
pieces they need.

❌ Incorrect:

```tsx
function Composer({renderHeader, renderFooter, showAttachments, showFormatting}: Props) {
    return (
        <form>
            {renderHeader?.()}
            <Input />
            {showAttachments && <Attachments />}
            {renderFooter ? renderFooter() : <Footer />}
        </form>
    )
}
```

✅ Correct:

```tsx
const ComposerContext = createContext<ComposerContextValue | null>(null)

function ComposerProvider({children, state, actions, meta}: ProviderProps) {
    return (
        <ComposerContext.Provider value={{state, actions, meta}}>
            {children}
        </ComposerContext.Provider>
    )
}

function ComposerFrame({children}: {children: React.ReactNode}) {
    return <form>{children}</form>
}

function ComposerInput() {
    const {
        state,
        actions: {update},
        meta: {inputRef}
    } = useContext(ComposerContext)!
    return (
        <input
            ref={inputRef}
            value={state.input}
            onChange={e => update(s => ({...s, input: e.target.value}))}
        />
    )
}

const Composer = {
    Provider: ComposerProvider,
    Frame: ComposerFrame,
    Input: ComposerInput,
    Submit: ComposerSubmit,
    Footer: ComposerFooter
}
```

> **React 19+:** Replace `useContext(ComposerContext)` with `use(ComposerContext)`. Replace
> `forwardRef` with `ref` as a regular prop.

---

## 2. State Management

**Impact: MEDIUM**

### 2.1 Decouple State Management from UI

The provider should be the only place that knows how state is managed. UI components consume the
context interface — they don't know if state comes from useState, Zustand, or a server sync.

❌ Incorrect — UI coupled to state implementation:

```tsx
function ChannelComposer({channelId}: {channelId: string}) {
    const state = useGlobalChannelState(channelId)
    const {submit, updateInput} = useChannelSync(channelId)
    return (
        <Composer.Frame>
            <Composer.Input
                value={state.input}
                onChange={updateInput}
            />
            <Composer.Submit onPress={submit} />
        </Composer.Frame>
    )
}
```

✅ Correct — state isolated in provider:

```tsx
function ChannelProvider({channelId, children}: {channelId: string; children: React.ReactNode}) {
    const {state, update, submit} = useGlobalChannel(channelId)
    const inputRef = useRef(null)
    return (
        <Composer.Provider
            state={state}
            actions={{update, submit}}
            meta={{inputRef}}
        >
            {children}
        </Composer.Provider>
    )
}

// UI only knows the context interface
function ChannelComposer() {
    return (
        <Composer.Frame>
            <Composer.Header />
            <Composer.Input />
            <Composer.Footer>
                <Composer.Submit />
            </Composer.Footer>
        </Composer.Frame>
    )
}
```

### 2.2 Define Generic Context Interfaces for Dependency Injection

Define a generic interface with `state`, `actions`, and `meta`. Any provider can implement it — same
UI works with different state implementations.

```tsx
interface ComposerState {
    input: string
    attachments: Attachment[]
    isSubmitting: boolean
}

interface ComposerActions {
    update: (updater: (state: ComposerState) => ComposerState) => void
    submit: () => void
}

interface ComposerMeta {
    inputRef: React.RefObject<HTMLInputElement>
}

interface ComposerContextValue {
    state: ComposerState
    actions: ComposerActions
    meta: ComposerMeta
}
```

Different providers implement the same interface:

```tsx
// Local state for ephemeral forms
function ForwardMessageProvider({children}: {children: React.ReactNode}) {
    const [state, setState] = useState(initialState)
    const submit = useForwardMessage()
    return (
        <Composer.Provider
            state={state}
            actions={{update: setState, submit}}
            meta={{inputRef: useRef(null)}}
        >
            {children}
        </Composer.Provider>
    )
}

// Global synced state for channels
function ChannelProvider({channelId, children}: Props) {
    const {state, update, submit} = useGlobalChannel(channelId)
    return (
        <Composer.Provider
            state={state}
            actions={{update, submit}}
            meta={{inputRef: useRef(null)}}
        >
            {children}
        </Composer.Provider>
    )
}
```

### 2.3 Lift State into Provider Components

Move state into providers so sibling components outside the main UI can access it without prop
drilling.

❌ Incorrect — state trapped inside component:

```tsx
function ForwardMessageComposer() {
    const [state, setState] = useState(initialState)
    return (
        <Composer.Frame>
            <Composer.Input />
            <Composer.Footer />
        </Composer.Frame>
    )
}

// How does ForwardButton access composer state?
function ForwardMessageDialog() {
    return (
        <Dialog>
            <ForwardMessageComposer />
            <ForwardButton /> {/* Can't access state */}
        </Dialog>
    )
}
```

✅ Correct — state lifted to provider:

```tsx
function ForwardMessageProvider({children}: {children: React.ReactNode}) {
    const [state, setState] = useState(initialState)
    const forwardMessage = useForwardMessage()
    return (
        <Composer.Provider
            state={state}
            actions={{update: setState, submit: forwardMessage}}
            meta={{inputRef: useRef(null)}}
        >
            {children}
        </Composer.Provider>
    )
}

function ForwardMessageDialog() {
    return (
        <ForwardMessageProvider>
            <Dialog>
                <ForwardMessageComposer />
                <MessagePreview /> {/* Can read state */}
                <DialogActions>
                    <CancelButton />
                    <ForwardButton /> {/* Can call submit */}
                </DialogActions>
            </Dialog>
        </ForwardMessageProvider>
    )
}

function ForwardButton() {
    const {actions} = useContext(ComposerContext)!
    return <button onClick={actions.submit}>Forward</button>
}
```

Components that need shared state don't have to be visually nested — they just need to be within the
same provider.

---

## 3. Implementation Patterns

**Impact: MEDIUM**

### 3.1 Create Explicit Component Variants

Instead of one component with many boolean props, create explicit variant components that compose
shared pieces.

❌ Incorrect:

```tsx
<Composer
    isThread
    isEditing={false}
    channelId='abc'
    showAttachments
    showFormatting={false}
/>
```

✅ Correct:

```tsx
<ThreadComposer channelId="abc" />
<EditMessageComposer messageId="xyz" />
<ForwardMessageComposer messageId="123" />
```

### 3.2 Prefer Composing Children Over Render Props

Use `children` for composition instead of `renderX` props. Reserve render props for when the parent
needs to pass data back to the child.

❌ Incorrect:

```tsx
<Composer
    renderHeader={() => <CustomHeader />}
    renderFooter={() => (
        <>
            <Formatting />
            <Emojis />
        </>
    )}
    renderActions={() => <SubmitButton />}
/>
```

✅ Correct:

```tsx
<Composer.Frame>
    <CustomHeader />
    <Composer.Input />
    <Composer.Footer>
        <Composer.Formatting />
        <Composer.Emojis />
        <SubmitButton />
    </Composer.Footer>
</Composer.Frame>
```

Render props are appropriate when the parent provides data:
`<List data={items} renderItem={({ item }) => <Item item={item} />} />`

---

## 4. Bundle Size Optimization

**Impact: CRITICAL**

### 4.1 Avoid Barrel File Imports

Import directly from source files instead of barrel files (index.ts re-exports). Barrel files with
many re-exports add 200-800ms per import.

❌ Incorrect:

```tsx
import {Button, Input, Modal} from '@/components'
```

✅ Correct:

```tsx
import {Button} from '@/components/Button'
import {Input} from '@/components/Input'
import {Modal} from '@/components/Modal'
```

### 4.2 Conditional Module Loading

Load large data or modules only when features are activated.

```tsx
function FeaturePanel({enabled}: {enabled: boolean}) {
    const [mod, setMod] = useState<typeof import('./heavy-module') | null>(null)

    useEffect(() => {
        if (enabled) {
            import('./heavy-module').then(setMod)
        }
    }, [enabled])

    if (!mod) return null
    return <mod.HeavyComponent />
}
```

### 4.3 Lazy Load Heavy Components

Use `React.lazy` + `Suspense` for large components not needed on initial render.

❌ Incorrect:

```tsx
import MonacoEditor from '@monaco-editor/react' // 300KB loaded immediately
```

✅ Correct:

```tsx
const MonacoEditor = React.lazy(() => import('@monaco-editor/react'))

function CodeEditor() {
    return (
        <Suspense fallback={<div>Loading editor...</div>}>
            <MonacoEditor />
        </Suspense>
    )
}
```

### 4.4 Preload Based on User Intent

Preload heavy bundles before they're needed by triggering imports on hover or focus.

```tsx
function SettingsButton() {
    const handleMouseEnter = () => {
        import('./SettingsPanel') // preload on hover
    }

    return (
        <button
            onMouseEnter={handleMouseEnter}
            onClick={openSettings}
        >
            Settings
        </button>
    )
}
```

---

## 5. Client-Side Data Fetching

**Impact: MEDIUM-HIGH**

### 5.1 Deduplicate Global Event Listeners

Share single event listeners across multiple component instances using a module-level Map instead of
registering N listeners.

```tsx
const listeners = new Map<string, Set<(data: any) => void>>()

function useEvent(eventName: string, callback: (data: any) => void) {
    useEffect(() => {
        if (!listeners.has(eventName)) {
            listeners.set(eventName, new Set())
            window.addEventListener(eventName, e => {
                listeners.get(eventName)?.forEach(cb => cb(e))
            })
        }
        listeners.get(eventName)!.add(callback)
        return () => {
            listeners.get(eventName)?.delete(callback)
        }
    }, [eventName, callback])
}
```

### 5.2 Use Passive Event Listeners for Scrolling

Add `{ passive: true }` to touch and wheel event listeners to enable immediate scrolling without
waiting for `preventDefault()` checks.

❌ Incorrect:

```tsx
element.addEventListener('touchmove', handler)
```

✅ Correct:

```tsx
element.addEventListener('touchmove', handler, {passive: true})
```

### 5.3 Version and Minimize localStorage Data

Add version prefixes to keys and store only necessary fields. Always wrap in try-catch since
localStorage throws in private browsing and when quota is exceeded.

```tsx
const STORAGE_VERSION = 'v2'
const key = `${STORAGE_VERSION}:user-preferences`

function savePreferences(prefs: Preferences) {
    try {
        const minimal = {theme: prefs.theme, locale: prefs.locale}
        localStorage.setItem(key, JSON.stringify(minimal))
    } catch {
        // Private browsing or quota exceeded
    }
}
```

---

## 6. Re-render Optimization

**Impact: MEDIUM**

### 6.1 Calculate Derived State During Rendering

Derive values during render instead of storing in state or updating via effects.

❌ Incorrect:

```tsx
const [items, setItems] = useState<Item[]>([])
const [filteredItems, setFilteredItems] = useState<Item[]>([])

useEffect(() => {
    setFilteredItems(items.filter(i => i.active))
}, [items])
```

✅ Correct:

```tsx
const [items, setItems] = useState<Item[]>([])
const filteredItems = items.filter(i => i.active)
```

### 6.2 Defer State Reads to Usage Point

Read dynamic state inside callbacks rather than subscribing via hooks if only used in event
handlers.

❌ Incorrect:

```tsx
const searchParams = useSearchParams() // from react-router or next/navigation

function handleClick() {
    navigate(`/page?${searchParams.toString()}`)
}
```

✅ Correct:

```tsx
function handleClick() {
    const searchParams = new URLSearchParams(window.location.search)
    navigate(`/page?${searchParams.toString()}`)
}
```

### 6.3 Do Not Wrap Simple Expressions in useMemo

Wrapping simple expressions (few operators, primitive results) in `useMemo` wastes more resources
than the expression itself.

❌ Incorrect:

```tsx
const isActive = useMemo(() => status === 'active', [status])
```

✅ Correct:

```tsx
const isActive = status === 'active'
```

### 6.4 Don't Define Components Inside Components

Defining components inside parents remounts them on every parent render, destroying state and DOM.

❌ Incorrect:

```tsx
function Parent() {
    function Child() {
        return <input />
    }
    return <Child />
}
```

✅ Correct:

```tsx
function Child({value}: {value: string}) {
    return <input defaultValue={value} />
}

function Parent() {
    return <Child value='hello' />
}
```

### 6.5 Extract Default Non-primitive Values to Constants

Extract default objects, functions, and arrays for memoized component props as module-level
constants.

❌ Incorrect:

```tsx
function List({ items = [], config = { sort: true } }: Props) { ... }
```

✅ Correct:

```tsx
const DEFAULT_ITEMS: Item[] = []
const DEFAULT_CONFIG = { sort: true }

function List({ items = DEFAULT_ITEMS, config = DEFAULT_CONFIG }: Props) { ... }
```

### 6.6 Extract to Memoized Components

Extract expensive work into memoized components to enable early returns before computation.

```tsx
const ExpensiveList = React.memo(function ExpensiveList({items}: {items: Item[]}) {
    return (
        <ul>
            {items.map(item => (
                <li key={item.id}>{expensiveRender(item)}</li>
            ))}
        </ul>
    )
})
```

### 6.7 Narrow Effect Dependencies

Use primitive dependencies instead of objects to minimize effect re-runs.

❌ Incorrect:

```tsx
useEffect(() => {
    fetchUser(user.id)
}, [user]) // re-runs whenever user object ref changes
```

✅ Correct:

```tsx
const {id} = user
useEffect(() => {
    fetchUser(id)
}, [id]) // only re-runs when id actually changes
```

### 6.8 Put Interaction Logic in Event Handlers

Run side effects from user actions in event handlers, not state + effects.

❌ Incorrect:

```tsx
const [submitted, setSubmitted] = useState(false)

useEffect(() => {
    if (submitted) {
        sendData(formData)
        setSubmitted(false)
    }
}, [submitted, formData])

function handleSubmit() {
    setSubmitted(true)
}
```

✅ Correct:

```tsx
function handleSubmit() {
    sendData(formData)
}
```

### 6.9 Split Combined Hook Computations

When hooks contain multiple independent tasks with different dependencies, split them.

❌ Incorrect:

```tsx
useEffect(() => {
    fetchUser(userId)
    logPageView(pageId)
}, [userId, pageId]) // both re-run when either changes
```

✅ Correct:

```tsx
useEffect(() => {
    fetchUser(userId)
}, [userId])
useEffect(() => {
    logPageView(pageId)
}, [pageId])
```

### 6.10 Subscribe to Derived State

Subscribe to derived boolean state instead of continuous values when only transitions matter.

```tsx
// Instead of re-rendering on every scroll position change
const isScrolledPast = useRef(false)

useEffect(() => {
    const handler = () => {
        const past = window.scrollY > 100
        if (past !== isScrolledPast.current) {
            isScrolledPast.current = past
            setShowHeader(past)
        }
    }
    window.addEventListener('scroll', handler, {passive: true})
    return () => window.removeEventListener('scroll', handler)
}, [])
```

### 6.11 Use Functional setState Updates

Use functional updates to prevent stale closures and create stable callback references.

❌ Incorrect:

```tsx
const [count, setCount] = useState(0)
const increment = useCallback(() => setCount(count + 1), [count]) // new ref every time count changes
```

✅ Correct:

```tsx
const [count, setCount] = useState(0)
const increment = useCallback(() => setCount(c => c + 1), []) // stable ref
```

### 6.12 Use Lazy State Initialization

Pass functions to `useState` for expensive initializers — runs only once at mount.

❌ Incorrect:

```tsx
const [data] = useState(JSON.parse(localStorage.getItem('data') || '{}'))
```

✅ Correct:

```tsx
const [data] = useState(() => JSON.parse(localStorage.getItem('data') || '{}'))
```

### 6.13 Use Transitions for Non-Urgent Updates

Mark frequent, non-urgent state updates as transitions with `startTransition()`.

```tsx
import {startTransition} from 'react'

function SearchInput() {
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<Result[]>([])

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
        setQuery(e.target.value)
        startTransition(() => {
            setResults(search(e.target.value))
        })
    }

    return (
        <input
            value={query}
            onChange={handleChange}
        />
    )
}
```

### 6.14 Use useDeferredValue for Expensive Derived Renders

Keep input responsive while expensive computations lag behind.

```tsx
function SearchResults({query}: {query: string}) {
    const deferredQuery = useDeferredValue(query)
    const results = useMemo(() => expensiveSearch(deferredQuery), [deferredQuery])
    return (
        <ul>
            {results.map(r => (
                <li key={r.id}>{r.name}</li>
            ))}
        </ul>
    )
}
```

### 6.15 Use useRef for Transient Values

Store frequently-changing values that don't need re-renders in `useRef`.

```tsx
// Mouse position tracking — no re-renders needed
const mousePos = useRef({x: 0, y: 0})

useEffect(() => {
    const handler = (e: MouseEvent) => {
        mousePos.current = {x: e.clientX, y: e.clientY}
    }
    window.addEventListener('mousemove', handler)
    return () => window.removeEventListener('mousemove', handler)
}, [])
```

---

## 7. Rendering Performance

**Impact: MEDIUM**

### 7.1 Animate SVG Wrapper Instead of SVG Element

Wrap SVG in a `<div>` and animate the wrapper for hardware acceleration.

❌ Incorrect:

```tsx
<svg style={{transform: `rotate(${angle}deg)`}}>...</svg>
```

✅ Correct:

```tsx
<div style={{transform: `rotate(${angle}deg)`, willChange: 'transform'}}>
    <svg>...</svg>
</div>
```

### 7.2 CSS content-visibility for Long Lists

Apply `content-visibility: auto` to defer off-screen rendering (10x faster for 1000+ items).

```css
.list-item {
    content-visibility: auto;
    contain-intrinsic-size: 0 50px;
}
```

### 7.3 Hoist Static JSX Elements

Extract static JSX outside components as module-level variables.

❌ Incorrect:

```tsx
function Card({children}: {children: React.ReactNode}) {
    return (
        <div>
            <div className='divider' /> {/* recreated every render */}
            {children}
        </div>
    )
}
```

✅ Correct:

```tsx
const divider = <div className='divider' />

function Card({children}: {children: React.ReactNode}) {
    return (
        <div>
            {divider}
            {children}
        </div>
    )
}
```

### 7.4 Optimize SVG Precision

Reduce SVG coordinate decimal places and use SVGO for automated optimization.

❌ Incorrect:

```tsx
<path d='M 12.3456789 45.6789012 L 78.9012345 23.4567890' />
```

✅ Correct:

```tsx
<path d='M 12.3 45.7 L 79 23.5' />
```

### 7.5 Use Activity Component for Show/Hide

React's `<Activity>` component preserves state and DOM for components that frequently toggle
visibility.

```tsx
import {Activity} from 'react'

function TabPanel({activeTab}: {activeTab: string}) {
    return (
        <>
            <Activity mode={activeTab === 'editor' ? 'visible' : 'hidden'}>
                <ExpensiveEditor />
            </Activity>
            <Activity mode={activeTab === 'preview' ? 'visible' : 'hidden'}>
                <Preview />
            </Activity>
        </>
    )
}
```

> Note: `<Activity>` is experimental in React 19 canary. Check React docs for stable availability.

### 7.6 Use defer or async on Script Tags

Add `defer` or `async` to prevent render-blocking. Use `defer` for order-dependent scripts; `async`
for independent ones.

### 7.7 Use Explicit Conditional Rendering

Use ternary operators instead of `&&` when the condition can be falsy values like `0` or `NaN`.

❌ Incorrect:

```tsx
{
    count && <Badge count={count} />
}
{
    /* renders "0" when count is 0 */
}
```

✅ Correct:

```tsx
{
    count > 0 ? <Badge count={count} /> : null
}
```

### 7.8 Use React DOM Resource Hints

```tsx
import {prefetchDNS, preconnect, preload, preinit} from 'react-dom'

function App() {
    prefetchDNS('https://api.example.com')
    preconnect('https://cdn.example.com')
    preload('/fonts/inter.woff2', {as: 'font', type: 'font/woff2', crossOrigin: 'anonymous'})
    preinit('/critical.css', {as: 'style'})
    return <main>...</main>
}
```

### 7.9 Use useTransition Over Manual Loading States

Use `useTransition` instead of manual `useState` for loading states.

❌ Incorrect:

```tsx
const [isLoading, setIsLoading] = useState(false)

async function handleClick() {
    setIsLoading(true)
    await doWork()
    setIsLoading(false)
}
```

✅ Correct:

```tsx
const [isPending, startTransition] = useTransition()

function handleClick() {
    startTransition(async () => {
        await doWork()
    })
}
```

---

## 8. JavaScript Performance

**Impact: LOW-MEDIUM**

### 8.1 Avoid Layout Thrashing

Batch style writes before reading layout properties.

❌ Incorrect:

```tsx
elements.forEach(el => {
    const height = el.offsetHeight // read → forces layout
    el.style.height = `${height * 2}px` // write → invalidates layout
})
```

✅ Correct:

```tsx
const heights = elements.map(el => el.offsetHeight) // batch reads
elements.forEach((el, i) => {
    el.style.height = `${heights[i] * 2}px` // batch writes
})
```

### 8.2 Build Index Maps for Repeated Lookups

Convert arrays to Maps for repeated `.find()` calls — O(1) instead of O(n).

```tsx
const userMap = new Map(users.map(u => [u.id, u]))

// O(1) lookup
const user = userMap.get(userId)
```

### 8.3 Cache Property Access in Loops

Extract object property lookups outside loops.

❌ Incorrect:

```tsx
for (let i = 0; i < items.length; i++) {
    process(config.settings.threshold, items[i])
}
```

✅ Correct:

```tsx
const threshold = config.settings.threshold
for (let i = 0; i < items.length; i++) {
    process(threshold, items[i])
}
```

### 8.4 Cache Repeated Function Calls

Use module-level Maps for caching function results with identical inputs.

```tsx
const cache = new Map<string, Result>()

function expensiveComputation(input: string): Result {
    if (cache.has(input)) return cache.get(input)!
    const result = /* expensive work */ cache.set(input, result)
    return result
}
```

### 8.5 Cache Storage API Calls

Cache localStorage/sessionStorage reads in memory — these synchronous APIs are expensive.

```tsx
let cachedTheme: string | null = null

function getTheme(): string {
    if (cachedTheme === null) {
        try {
            cachedTheme = localStorage.getItem('theme') ?? 'light'
        } catch {
            cachedTheme = 'light'
        }
    }
    return cachedTheme
}
```

### 8.6 Combine Multiple Array Iterations

Combine `.filter()` and `.map()` into a single loop.

❌ Incorrect:

```tsx
const result = items.filter(item => item.active).map(item => item.name)
```

✅ Correct:

```tsx
const result: string[] = []
for (const item of items) {
    if (item.active) result.push(item.name)
}
```

Or use `flatMap`:

```tsx
const result = items.flatMap(item => (item.active ? [item.name] : []))
```

### 8.7 Early Length Check for Array Comparisons

Check array lengths first before expensive operations.

```tsx
function arraysEqual(a: unknown[], b: unknown[]): boolean {
    if (a.length !== b.length) return false
    return a.every((val, i) => deepEqual(val, b[i]))
}
```

### 8.8 Early Return from Functions

Return immediately when the result is determined.

```tsx
function findFirst(items: Item[], predicate: (item: Item) => boolean): Item | undefined {
    for (const item of items) {
        if (predicate(item)) return item
    }
    return undefined
}
```

### 8.9 Hoist RegExp Creation

Move RegExp literals outside render functions.

❌ Incorrect:

```tsx
function validate(input: string) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(input)
}
```

✅ Correct:

```tsx
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(input: string) {
    return EMAIL_REGEX.test(input)
}
```

### 8.10 Use flatMap to Map and Filter in One Pass

```tsx
// Instead of .map().filter(Boolean)
const results = items.flatMap(item => {
    const transformed = transform(item)
    return transformed ? [transformed] : []
})
```

### 8.11 Use Loop for Min/Max Instead of Sort

O(n) loop instead of O(n log n) sort.

❌ Incorrect:

```tsx
const max = items.sort((a, b) => b.value - a.value)[0]
```

✅ Correct:

```tsx
let max = items[0]
for (let i = 1; i < items.length; i++) {
    if (items[i].value > max.value) max = items[i]
}
```

### 8.12 Use Set/Map for O(1) Lookups

Convert arrays to Sets for repeated membership checks.

❌ Incorrect:

```tsx
const allowedIds = ['a', 'b', 'c']
items.filter(item => allowedIds.includes(item.id)) // O(n) per check
```

✅ Correct:

```tsx
const allowedIds = new Set(['a', 'b', 'c'])
items.filter(item => allowedIds.has(item.id)) // O(1) per check
```

### 8.13 Use toSorted() Instead of sort() for Immutability

Prevent React state/prop mutation bugs.

❌ Incorrect:

```tsx
const sorted = items.sort((a, b) => a.name.localeCompare(b.name)) // mutates original
```

✅ Correct:

```tsx
const sorted = items.toSorted((a, b) => a.name.localeCompare(b.name)) // new array
```

---

## 9. Advanced Patterns

**Impact: LOW**

### 9.1 Initialize App Once, Not Per Mount

Use module-level guards instead of `useEffect([])` since components can remount in StrictMode.

❌ Incorrect:

```tsx
function App() {
    useEffect(() => {
        initAnalytics() // runs twice in StrictMode
    }, [])
}
```

✅ Correct:

```tsx
let initialized = false

function App() {
    useEffect(() => {
        if (!initialized) {
            initialized = true
            initAnalytics()
        }
    }, [])
}
```

Or initialize at module scope:

```tsx
initAnalytics() // runs once when module loads

function App() {
    return <main>...</main>
}
```

### 9.2 Store Event Handlers in Refs

Store callbacks in refs when used in effects that shouldn't re-subscribe on callback changes.

```tsx
function useInterval(callback: () => void, delay: number) {
    const callbackRef = useRef(callback)
    callbackRef.current = callback

    useEffect(() => {
        const id = setInterval(() => callbackRef.current(), delay)
        return () => clearInterval(id)
    }, [delay]) // callback changes don't restart the interval
}
```

### 9.3 useEffectEvent for Stable Callback Refs

Use React's `useEffectEvent` to access latest callback values in effects without adding them to
dependency arrays.

```tsx
function useConnection(url: string, onMessage: (msg: Message) => void) {
    const onMsg = useEffectEvent(onMessage)

    useEffect(() => {
        const ws = new WebSocket(url)
        ws.onmessage = e => onMsg(JSON.parse(e.data))
        return () => ws.close()
    }, [url]) // onMessage changes don't reconnect
}
```

> Note: `useEffectEvent` is experimental in React 19 canary. Check React docs for stable
> availability.
