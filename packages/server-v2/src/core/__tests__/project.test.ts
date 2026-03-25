import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProjectManager } from '../project.js'

// Mock the fs module to control file reads
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

import { readFile } from 'node:fs/promises'

const mockReadFile = vi.mocked(readFile)

describe('ProjectManager', () => {
  let manager: ProjectManager

  beforeEach(() => {
    manager = new ProjectManager()
    vi.clearAllMocks()
  })

  describe('load', () => {
    it('should load projects from projects.json', async () => {
      const projects = [
        { id: 'p1', name: 'Project 1', path: '/home/user/proj1', createdAt: 1000, updatedAt: 2000 },
        { id: 'p2', name: 'Project 2', path: '/home/user/proj2', icon: 'rocket', createdAt: 1500, updatedAt: 2500 },
      ]

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        if (typeof filePath === 'string' && filePath.endsWith('models.json')) {
          throw new Error('ENOENT')
        }
        throw new Error('ENOENT')
      })

      await manager.load()

      expect(manager.list()).toHaveLength(2)
      expect(manager.get('p1')!.name).toBe('Project 1')
      expect(manager.get('p2')!.icon).toBe('rocket')
    })

    it('should handle missing projects.json gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))
      await manager.load()
      expect(manager.list()).toHaveLength(0)
    })

    it('should load default provider from models.json', async () => {
      const projects = [{ id: 'p1', name: 'P1', path: '/tmp/p1' }]
      const models = { defaultProviderId: 'claude-opus-4' }

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        if (typeof filePath === 'string' && filePath.endsWith('models.json')) {
          return JSON.stringify(models)
        }
        throw new Error('ENOENT')
      })

      await manager.load()

      expect(manager.getDefaultProvider('p1')).toBe('claude-opus-4')
      expect(manager.get('p1')!.defaultProviderId).toBe('claude-opus-4')
    })

    it('should load per-project provider overrides', async () => {
      const projects = [
        { id: 'p1', name: 'P1', path: '/tmp/p1' },
        { id: 'p2', name: 'P2', path: '/tmp/p2' },
      ]
      const models = {
        defaultProviderId: 'claude-sonnet-4-6',
        projectProviders: {
          p1: 'claude-opus-4',
        },
      }

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        if (typeof filePath === 'string' && filePath.endsWith('models.json')) {
          return JSON.stringify(models)
        }
        throw new Error('ENOENT')
      })

      await manager.load()

      expect(manager.getDefaultProvider('p1')).toBe('claude-opus-4')
      expect(manager.getDefaultProvider('p2')).toBe('claude-sonnet-4-6')
    })

    it('should use fallback default provider when models.json is missing', async () => {
      const projects = [{ id: 'p1', name: 'P1', path: '/tmp/p1' }]

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        throw new Error('ENOENT')
      })

      await manager.load()

      expect(manager.getDefaultProvider('p1')).toBe('claude-sonnet-4-6')
    })
  })

  describe('list', () => {
    it('should return all loaded projects', async () => {
      const projects = [
        { id: 'p1', name: 'P1', path: '/a' },
        { id: 'p2', name: 'P2', path: '/b' },
        { id: 'p3', name: 'P3', path: '/c' },
      ]

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        throw new Error('ENOENT')
      })

      await manager.load()
      expect(manager.list()).toHaveLength(3)
    })

    it('should return empty array when no projects loaded', () => {
      expect(manager.list()).toHaveLength(0)
    })
  })

  describe('get', () => {
    it('should return a project by id', async () => {
      const projects = [{ id: 'p1', name: 'My Project', path: '/home/user/proj' }]

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        throw new Error('ENOENT')
      })

      await manager.load()

      const project = manager.get('p1')
      expect(project).not.toBeNull()
      expect(project!.name).toBe('My Project')
      expect(project!.path).toBe('/home/user/proj')
    })

    it('should return null for unknown project', () => {
      expect(manager.get('non-existent')).toBeNull()
    })
  })

  describe('getPath', () => {
    it('should return the project path', async () => {
      const projects = [{ id: 'p1', name: 'P1', path: '/home/user/project' }]

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        throw new Error('ENOENT')
      })

      await manager.load()
      expect(manager.getPath('p1')).toBe('/home/user/project')
    })

    it('should return null for unknown project', () => {
      expect(manager.getPath('non-existent')).toBeNull()
    })
  })

  describe('getDefaultProvider', () => {
    it('should return project-specific provider override', async () => {
      const projects = [{ id: 'p1', name: 'P1', path: '/a' }]
      const models = {
        defaultProviderId: 'claude-sonnet-4-6',
        projectProviders: { p1: 'custom-model' },
      }

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        if (typeof filePath === 'string' && filePath.endsWith('models.json')) {
          return JSON.stringify(models)
        }
        throw new Error('ENOENT')
      })

      await manager.load()
      expect(manager.getDefaultProvider('p1')).toBe('custom-model')
    })

    it('should return global default provider when no project override', async () => {
      const projects = [{ id: 'p1', name: 'P1', path: '/a' }]
      const models = { defaultProviderId: 'claude-opus-4' }

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        if (typeof filePath === 'string' && filePath.endsWith('models.json')) {
          return JSON.stringify(models)
        }
        throw new Error('ENOENT')
      })

      await manager.load()
      expect(manager.getDefaultProvider('p1')).toBe('claude-opus-4')
    })

    it('should return hardcoded default provider when no models.json', () => {
      expect(manager.getDefaultProvider('unknown')).toBe('claude-sonnet-4-6')
    })
  })

  describe('toConfig defaults', () => {
    it('should provide default icon when none set', async () => {
      const projects = [{ id: 'p1', name: 'P1', path: '/a' }]

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        throw new Error('ENOENT')
      })

      await manager.load()
      expect(manager.get('p1')!.icon).toBe('')
    })

    it('should set defaultPermissionMode to default', async () => {
      const projects = [{ id: 'p1', name: 'P1', path: '/a' }]

      mockReadFile.mockImplementation(async (filePath: any) => {
        if (typeof filePath === 'string' && filePath.endsWith('projects.json')) {
          return JSON.stringify(projects)
        }
        throw new Error('ENOENT')
      })

      await manager.load()
      expect(manager.get('p1')!.defaultPermissionMode).toBe('default')
    })
  })
})
