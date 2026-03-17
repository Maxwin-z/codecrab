import { ChevronLeft } from 'lucide-react'
import { useNavigate } from 'react-router'

interface MobileHeaderProps {
  title: string
  backTo?: string
}

export function MobileHeader({ title, backTo }: MobileHeaderProps) {
  const navigate = useNavigate()

  return (
    <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-xl border-b border-border shrink-0">
      <div className="flex items-center h-11 px-4">
        {backTo && (
          <button
            onClick={() => navigate(backTo)}
            className="flex items-center -ml-2 mr-1 text-primary"
          >
            <ChevronLeft className="w-5 h-5" />
            <span className="text-[15px]">Back</span>
          </button>
        )}
        <h1 className="text-[17px] font-semibold truncate">{title}</h1>
      </div>
    </header>
  )
}
