import express from 'express'
import setupRouter from './api/setup'

const app = express()
const PORT = 4200

app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() })
})

app.use('/api/setup', setupRouter)

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})
