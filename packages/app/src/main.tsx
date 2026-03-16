import React, { useCallback, useEffect, useState, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router'
import { LoadingScreen } from '@/components/LoadingScreen'
import { SetupPage } from '@/components/SetupPage'
import { HomePage } from '@/components/HomePage'
import { CreateProjectPage } from '@/components/CreateProjectPage'
import { LoginPage } from '@/components/LoginPage'
import { ChatPage } from '@/components/ChatPage'
import { DebugPage } from '@/components/DebugPage'
import { SoulPage } from '@/components/SoulPage'
import { CronPage } from '@/components/CronPage'
import { WebSocketProvider } from '@/hooks/WebSocketContext'
import { checkAuthStatus, authFetch, clearToken } from '@/lib/auth'
import './index.css'

function AppRoutes() {
  const navigate = useNavigate()
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading')
  const [setupStatus, setSetupStatus] = useState<'loading' | 'initialized' | 'uninitialized'>('loading')
  const retryCountRef = useRef(0)

  const checkAuth = useCallback(async () => {
    const { configured, valid } = await checkAuthStatus()
    // If server has no auth configured, treat as authenticated
    if (!configured) {
      setAuthState('authenticated')
      return
    }
    // Server has auth configured, check if our token is valid
    setAuthState(valid ? 'authenticated' : 'unauthenticated')
  }, [])

  const checkSetup = useCallback(async () => {
    try {
      const res = await authFetch('/api/setup/status', {}, () => {
        // Handle 401 by clearing token and redirecting to login
        clearToken()
        setAuthState('unauthenticated')
      })
      if (res.status === 401) {
        clearToken()
        setAuthState('unauthenticated')
        return
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = await res.json()
      setSetupStatus(data.initialized ? 'initialized' : 'uninitialized')
      retryCountRef.current = 0
    } catch (err) {
      // server unreachable — retry with max attempts
      retryCountRef.current++
      if (retryCountRef.current < 5) {
        setTimeout(checkSetup, 2000)
      } else {
        // Max retries reached, default to uninitialized
        console.error('Failed to check setup status:', err)
        setSetupStatus('uninitialized')
      }
    }
  }, [])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  useEffect(() => {
    if (authState === 'authenticated') {
      retryCountRef.current = 0
      checkSetup()
    }
  }, [authState, checkSetup])

  const handleLogin = useCallback(() => {
    setAuthState('authenticated')
    setSetupStatus('loading') // Reset setup status to trigger checkSetup
  }, [])

  const handleUnauthorized = useCallback(() => {
    clearToken()
    setAuthState('unauthenticated')
    setSetupStatus('loading')
    navigate('/login')
  }, [navigate])

  if (authState === 'loading') {
    return <LoadingScreen />
  }

  if (authState === 'unauthenticated') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onLogin={handleLogin} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  if (setupStatus === 'loading') {
    return <LoadingScreen />
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/setup" element={
        <SetupPage
          onComplete={() => {
            if (setupStatus === 'uninitialized') {
              setSetupStatus('initialized')
            }
            navigate('/')
          }}
          onUnauthorized={handleUnauthorized}
        />
      } />
      <Route path="/projects/new" element={
        setupStatus === 'initialized'
          ? <CreateProjectPage onUnauthorized={handleUnauthorized} />
          : <Navigate to="/setup" replace />
      } />
      <Route path="/chat" element={
        setupStatus === 'initialized'
          ? <ChatPage onUnauthorized={handleUnauthorized} />
          : <Navigate to="/setup" replace />
      } />
      <Route path="/soul" element={
        setupStatus === 'initialized'
          ? <SoulPage onUnauthorized={handleUnauthorized} />
          : <Navigate to="/setup" replace />
      } />
      <Route path="/cron" element={
        setupStatus === 'initialized'
          ? <CronPage onUnauthorized={handleUnauthorized} />
          : <Navigate to="/setup" replace />
      } />
      <Route path="/debug" element={<DebugPage />} />
      <Route path="/" element={
        setupStatus === 'initialized'
          ? <HomePage onOpenSetup={() => navigate('/setup')} onUnauthorized={handleUnauthorized} />
          : <Navigate to="/setup" replace />
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <WebSocketProvider>
        <AppRoutes />
      </WebSocketProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
