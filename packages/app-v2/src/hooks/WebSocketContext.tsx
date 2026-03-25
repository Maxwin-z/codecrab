import { createContext, useContext } from 'react'
import { useWebSocket, type UseWebSocketReturn } from './useWebSocket'

const WebSocketContext = createContext<UseWebSocketReturn | null>(null)

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const ws = useWebSocket()
  return <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
}

export function useWs(): UseWebSocketReturn {
  const ctx = useContext(WebSocketContext)
  if (!ctx) throw new Error('useWs must be used within WebSocketProvider')
  return ctx
}
