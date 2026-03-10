import React, { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router'
import { LoadingScreen } from '@/components/LoadingScreen'
import { SetupPage } from '@/components/SetupPage'
import { HomePage } from '@/components/HomePage'
import './index.css'

function AppRoutes() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<'loading' | 'initialized' | 'uninitialized'>('loading')

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/status')
      const data = await res.json()
      setStatus(data.initialized ? 'initialized' : 'uninitialized')
    } catch {
      // server unreachable — retry after delay
      setTimeout(checkStatus, 2000)
    }
  }, [])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  if (status === 'loading') {
    return <LoadingScreen />
  }

  return (
    <Routes>
      <Route path="/setup" element={<SetupPage onComplete={() => { setStatus('initialized'); navigate('/') }} />} />
      <Route path="/" element={
        status === 'initialized'
          ? <HomePage onOpenSetup={() => navigate('/setup')} />
          : <Navigate to="/setup" replace />
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </React.StrictMode>,
)
