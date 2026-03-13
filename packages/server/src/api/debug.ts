// Debug API — public endpoints for troubleshooting
import { Router, type Router as RouterType } from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { Project } from '@codeclaws/shared'
import { getSessionsList } from '../ws/index.js'

const CONFIG_DIR = path.join(os.homedir(), '.codeclaws')
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json')

async function readProjects(): Promise<Project[]> {
  try {
    const data = await fs.readFile(PROJECTS_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

const router: RouterType = Router()

// List all sessions grouped by project, with session status
router.get('/sessions', async (_req, res) => {
  const projects = await readProjects()
  const allSessions = getSessionsList()

  // Group sessions by projectId
  const sessionsByProject = new Map<string, typeof allSessions>()
  const unassigned: typeof allSessions = []

  for (const session of allSessions) {
    if (session.projectId) {
      if (!sessionsByProject.has(session.projectId)) {
        sessionsByProject.set(session.projectId, [])
      }
      sessionsByProject.get(session.projectId)!.push(session)
    } else {
      unassigned.push(session)
    }
  }

  const result = projects.map((project) => ({
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      icon: project.icon,
    },
    sessions: (sessionsByProject.get(project.id) || []).sort(
      (a, b) => b.lastModified - a.lastModified
    ),
  }))

  // Include unassigned sessions (no projectId)
  if (unassigned.length > 0) {
    result.push({
      project: {
        id: '_unassigned',
        name: 'Unassigned',
        path: '',
        icon: '',
      },
      sessions: unassigned.sort((a, b) => b.lastModified - a.lastModified),
    })
  }

  res.json(result)
})

export default router
