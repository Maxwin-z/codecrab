import { Router, type Router as RouterType } from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { Project } from '@codecrab/shared'

const CONFIG_DIR = path.join(os.homedir(), '.codecrab')
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json')

async function ensureDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
}

async function readProjects(): Promise<Project[]> {
  await ensureDir()
  try {
    const data = await fs.readFile(PROJECTS_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

async function writeProjects(projects: Project[]) {
  await ensureDir()
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2))
}

const router: RouterType = Router()

// List all projects (sorted by updatedAt desc)
router.get('/', async (_req, res) => {
  const projects = await readProjects()
  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  res.json(projects)
})

// Create project
router.post('/', async (req, res) => {
  const { name, path: projectPath, icon } = req.body as {
    name?: string
    path?: string
    icon?: string
  }

  if (!name || !projectPath) {
    res.status(400).json({ error: 'Missing name or path' })
    return
  }

  const projects = await readProjects()

  if (projects.some((p) => p.path === projectPath)) {
    res.status(409).json({ error: 'A project already exists for this directory' })
    return
  }

  const now = Date.now()
  const project: Project = {
    id: `proj-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    path: projectPath,
    icon: icon || '📁',
    createdAt: now,
    updatedAt: now,
  }

  projects.push(project)
  await writeProjects(projects)
  res.status(201).json(project)
})

// Get single project
router.get('/:id', async (req, res) => {
  const projects = await readProjects()
  const project = projects.find((p) => p.id === req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  res.json(project)
})

// Delete project
router.delete('/:id', async (req, res) => {
  const projects = await readProjects()
  const filtered = projects.filter((p) => p.id !== req.params.id)
  if (filtered.length === projects.length) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  await writeProjects(filtered)
  res.status(204).end()
})

export default router
