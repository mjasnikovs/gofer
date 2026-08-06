import React from 'react'
import ReactDOM from 'react-dom/client'
import {Theme} from '@astryxdesign/core/theme'
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'
import App from './App'
import {goferTheme} from './theme/gofer'
import './theme/gofer-theme.css'
import './theme/editor.css'
import './theme/inputs.css'
import './theme/rows.css'
import './theme/toolbar.css'

if (import.meta.env.MODE === 'webdriver') void import('@wdio/tauri-plugin')

const root = document.getElementById('root')

if (!root) {
    throw new Error('Application root was not found')
}

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
