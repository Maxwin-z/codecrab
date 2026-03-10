// File system API
//
// Endpoints:
//   GET  /api/files         — List directory contents
//   GET  /api/files/search  — Recursive file search
//   POST /api/files/mkdir   — Create directory

import { Router } from 'express'

const router = Router()

export default router
