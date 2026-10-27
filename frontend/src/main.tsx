import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './AuthContext'
import { ErrorBoundary } from './ErrorBoundary'
import { LocaleProvider } from './i18n/LocaleContext'
import { ThemeProvider } from './ThemeContext'
import { AssistProvider } from './AssistContext'
import { ToastProvider } from './ToastContext'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <LocaleProvider>
          <BrowserRouter>
            <AuthProvider>
              <ToastProvider>
                <AssistProvider>
                  <App />
                </AssistProvider>
              </ToastProvider>
            </AuthProvider>
          </BrowserRouter>
        </LocaleProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
