import React from 'react'
import ReactDOM from 'react-dom/client'
import {Theme} from '@astryxdesign/core/theme'
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'
import AppRouter from './router'
import {goferTheme} from './theme'

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
            <AppRouter />
        </Theme>
    </React.StrictMode>
)
