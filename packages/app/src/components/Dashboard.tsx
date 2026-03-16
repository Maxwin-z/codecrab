// Dashboard — Top section of HomePage with key module cards
//
// Currently contains the SOUL card. Future modules (Research, Orchestrator, etc.)
// will be added as additional cards in the grid.

import { SoulCard } from './SoulCard'
import type { SoulDocument, SoulStatus, EvolutionEntry } from '@/hooks/useSoul'

interface DashboardProps {
  soul: SoulDocument | null
  soulStatus: SoulStatus | null
  recentEvolution: EvolutionEntry[]
  loading: boolean
}

export function Dashboard({ soul, soulStatus, recentEvolution, loading }: DashboardProps) {
  if (loading) {
    return (
      <div className="px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="h-36 rounded-lg border bg-card animate-pulse" />
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 sm:px-6 pt-4 sm:pt-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <SoulCard
          soul={soul}
          status={soulStatus}
          recentEvolution={recentEvolution}
        />
        {/* Future: ResearchCard, OrchestratorCard, etc. */}
      </div>
    </div>
  )
}
