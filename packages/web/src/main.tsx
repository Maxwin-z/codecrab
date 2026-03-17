import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { Sidebar } from '@/components/Sidebar'
import { Home } from '@/pages/Home'
import { PaintingList } from '@/pages/PaintingList'
import { PaintingDetail } from '@/pages/PaintingDetail'
import './index.css'

function AppShell() {
  const isDesktop = useIsDesktop()

  return (
    <div className="h-dvh flex">
      {isDesktop && <Sidebar />}
      <main className="flex-1 flex flex-col overflow-hidden">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/projects/:projectId" element={<PaintingList />} />
          <Route
            path="/projects/:projectId/paintings/:paintingId"
            element={<PaintingDetail />}
          />
        </Routes>
      </main>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  </React.StrictMode>,
)
