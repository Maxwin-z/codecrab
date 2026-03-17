export interface Project {
  id: string
  name: string
  description: string
  paintingCount: number
  color: string
  updatedAt: string
}

export interface Painting {
  id: string
  projectId: string
  title: string
  description: string
  status: 'draft' | 'in-progress' | 'completed'
  createdAt: string
}

export interface Task {
  id: string
  title: string
  completed: boolean
  projectId?: string
}

export const projects: Project[] = [
  { id: '1', name: 'Portfolio Website', description: 'Personal portfolio with blog', paintingCount: 5, color: '#3B82F6', updatedAt: '2026-03-15' },
  { id: '2', name: 'E-Commerce App', description: 'Mobile-first online store', paintingCount: 4, color: '#10B981', updatedAt: '2026-03-14' },
  { id: '3', name: 'Dashboard UI', description: 'Analytics & monitoring', paintingCount: 3, color: '#8B5CF6', updatedAt: '2026-03-12' },
  { id: '4', name: 'Social Platform', description: 'Community & messaging', paintingCount: 3, color: '#F59E0B', updatedAt: '2026-03-10' },
  { id: '5', name: 'Design System', description: 'Component library', paintingCount: 3, color: '#EC4899', updatedAt: '2026-03-08' },
]

export const paintingsByProject: Record<string, Painting[]> = {
  '1': [
    { id: 'p1-1', projectId: '1', title: 'Landing Hero Section', description: 'Full-width hero with animated background', status: 'completed', createdAt: '2026-03-15' },
    { id: 'p1-2', projectId: '1', title: 'Project Gallery', description: 'Masonry grid layout for projects', status: 'in-progress', createdAt: '2026-03-14' },
    { id: 'p1-3', projectId: '1', title: 'Blog Post Layout', description: 'Article page with sidebar', status: 'draft', createdAt: '2026-03-13' },
    { id: 'p1-4', projectId: '1', title: 'Contact Form', description: 'Multi-step contact form', status: 'draft', createdAt: '2026-03-12' },
    { id: 'p1-5', projectId: '1', title: 'Navigation Bar', description: 'Responsive sticky navigation', status: 'completed', createdAt: '2026-03-11' },
  ],
  '2': [
    { id: 'p2-1', projectId: '2', title: 'Product Listing', description: 'Grid view with filters', status: 'completed', createdAt: '2026-03-14' },
    { id: 'p2-2', projectId: '2', title: 'Product Detail', description: 'Image carousel + specs', status: 'completed', createdAt: '2026-03-13' },
    { id: 'p2-3', projectId: '2', title: 'Shopping Cart', description: 'Slide-out cart drawer', status: 'in-progress', createdAt: '2026-03-12' },
    { id: 'p2-4', projectId: '2', title: 'Checkout Flow', description: '3-step checkout process', status: 'draft', createdAt: '2026-03-11' },
  ],
  '3': [
    { id: 'p3-1', projectId: '3', title: 'Overview Cards', description: 'KPI summary cards', status: 'completed', createdAt: '2026-03-12' },
    { id: 'p3-2', projectId: '3', title: 'Charts Panel', description: 'Line & bar chart layouts', status: 'in-progress', createdAt: '2026-03-11' },
    { id: 'p3-3', projectId: '3', title: 'Data Table', description: 'Sortable data grid', status: 'draft', createdAt: '2026-03-10' },
  ],
  '4': [
    { id: 'p4-1', projectId: '4', title: 'Feed Layout', description: 'Social media feed', status: 'in-progress', createdAt: '2026-03-10' },
    { id: 'p4-2', projectId: '4', title: 'Chat Interface', description: 'Real-time messaging UI', status: 'draft', createdAt: '2026-03-09' },
    { id: 'p4-3', projectId: '4', title: 'Profile Page', description: 'User profile with stats', status: 'draft', createdAt: '2026-03-08' },
  ],
  '5': [
    { id: 'p5-1', projectId: '5', title: 'Button Variants', description: 'All button styles & states', status: 'completed', createdAt: '2026-03-08' },
    { id: 'p5-2', projectId: '5', title: 'Form Components', description: 'Input, select, checkbox', status: 'completed', createdAt: '2026-03-07' },
    { id: 'p5-3', projectId: '5', title: 'Card Patterns', description: 'Various card layouts', status: 'in-progress', createdAt: '2026-03-06' },
  ],
}

export const tasks: Task[] = [
  { id: 't1', title: 'Review landing page design', completed: false, projectId: '1' },
  { id: 't2', title: 'Fix cart calculation bug', completed: false, projectId: '2' },
  { id: 't3', title: 'Add dark mode support', completed: true },
  { id: 't4', title: 'Update chart colors', completed: false, projectId: '3' },
  { id: 't5', title: 'Write API documentation', completed: true },
]

export function getProject(id: string): Project | undefined {
  return projects.find(p => p.id === id)
}

export function getPaintings(projectId: string): Painting[] {
  return paintingsByProject[projectId] || []
}

export function getPainting(projectId: string, paintingId: string): Painting | undefined {
  return getPaintings(projectId).find(p => p.id === paintingId)
}
