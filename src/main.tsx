import React from 'react'
import ReactDOM from 'react-dom/client'
import {Theme} from '@astryxdesign/core/theme'
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@fontsource-variable/figtree'
import App from './App'
import {watchForWindowClose} from './services/ui-state'
import {goferTheme} from './theme/gofer'
import './theme/gofer-theme.css'
import './theme/chat.css'
import './theme/editor.css'
import './theme/inputs.css'
import './theme/rows.css'
import './theme/sketch.css'
import './theme/tool-calls.css'
import './theme/toolbar.css'

if (import.meta.env.MODE === 'webdriver') void import('@wdio/tauri-plugin')

const root = document.getElementById('root')

if (!root) {
    throw new Error('Application root was not found')
}

watchForWindowClose()

ReactDOM.createRoot(root).render(
    <React.StrictMode>
        <Theme
            theme={goferTheme}
            mode='system'
        >
            <App />
        </Theme>
    </React.StrictMode>
)
