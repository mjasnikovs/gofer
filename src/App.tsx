import AppRouter from './app/router'
import {ErrorBoundary} from './components/application/ErrorBoundary'

export default function App() {
    return (
        <ErrorBoundary
            title='Gofer stopped drawing'
            description='Nothing was lost — the project, the chat and the settings are on disk.'
        >
            <AppRouter />
        </ErrorBoundary>
    )
}
