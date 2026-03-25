import type { CoreEngine } from '../core/index.js'
import { isSoulEnabled } from './settings.js'

const MIN_INTERACTION_LENGTH = 5  // Skip trivial interactions

export function initSoul(core: CoreEngine): void {
  core.on('turn:close', async (event) => {
    // Only trigger on user interactions
    if (event.type !== 'user') return

    // Check if soul evolution is enabled
    if (!isSoulEnabled()) return

    // Skip trivial interactions
    if (event.result.length < MIN_INTERACTION_LENGTH) return

    // Fire-and-forget: trigger evolution asynchronously
    triggerSoulEvolution(core, event).catch((err) => {
      console.error('[Soul] Evolution error:', err.message)
    })
  })
}

async function triggerSoulEvolution(core: CoreEngine, event: {
  projectId: string
  sessionId: string
  turnId: string
  result: string
}): Promise<void> {
  // TODO: Implement soul evolution logic
  // This would use the Agent to analyze the interaction and update the soul document
  // For now, this is a placeholder
  console.log(`[Soul] Evolution triggered for turn ${event.turnId}`)
}
