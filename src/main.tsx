import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { ConvexReactClient } from 'convex/react'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

const bg = '#e8e4dc', ink = '#1a1917', accent = '#5b3ff8', muted = '#8a7f6e'
const border = 'rgba(0,0,0,0.08)'

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('EventPulse crashed:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-5 px-6"
        style={{ background: bg, color: ink, fontFamily: "'Outfit', sans-serif" }}
      >
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: accent, boxShadow: '0 8px 24px rgba(91,63,248,0.3)' }}
        >
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
            <path d="M13 6v8M13 18.5v.5" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </div>
        <div className="text-center">
          <h1 className="text-xl font-bold" style={{ letterSpacing: '-0.02em' }}>
            Something went wrong
          </h1>
          <p className="text-sm mt-1" style={{ color: muted }}>
            Event Pulse hit an unexpected error.
          </p>
        </div>
        <pre
          className="text-[11px] font-mono max-w-md w-full overflow-auto rounded-2xl p-4 whitespace-pre-wrap"
          style={{ background: 'rgba(255,255,255,0.75)', border: `1px solid ${border}`, color: muted }}
        >
          {error.message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-3 rounded-2xl font-semibold text-sm"
          style={{ background: accent, color: 'white', boxShadow: '0 4px 14px rgba(91,63,248,0.3)' }}
        >
          Reload
        </button>
      </div>
    )
  }
}

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined
if (!convexUrl) {
  throw new Error('VITE_CONVEX_URL is not set. Run `npx convex dev` to generate .env.local.')
}
const convex = new ConvexReactClient(convexUrl)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
