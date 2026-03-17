// UserQuestionForm — Claude asks user questions with tabs UI
import { useState, useRef, useEffect, useCallback } from 'react'
import type { Question } from '@codecrab/shared'
import { ChevronLeft, ChevronRight, Check, CircleAlert } from 'lucide-react'

interface Props {
  questions: Question[]
  onSubmit: (answers: Record<string, string | string[]>) => void
  onCancel?: () => void
}

/** Truncate text for tab label */
function tabLabel(q: Question, index: number): string {
  const raw = q.header || q.question
  return raw.length > 20 ? raw.slice(0, 18) + '…' : raw
}

export function UserQuestionForm({ questions, onSubmit, onCancel }: Props) {
  const [activeTab, setActiveTab] = useState(0)
  // Keys are 1-based to match backend question numbering
  const toKey = (i: number) => String(i + 1)

  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() => {
    const initial: Record<string, string | string[]> = {}
    questions.forEach((q, i) => {
      initial[toKey(i)] = q.multiSelect ? [] : ''
    })
    return initial
  })
  const [customTexts, setCustomTexts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    questions.forEach((_, i) => {
      initial[toKey(i)] = ''
    })
    return initial
  })

  const tabsRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const el = tabsRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateScrollState()
    const el = tabsRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState, { passive: true })
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState])

  const scrollTabs = (dir: 'left' | 'right') => {
    const el = tabsRef.current
    if (!el) return
    el.scrollBy({ left: dir === 'left' ? -150 : 150, behavior: 'smooth' })
  }

  const handleSingleSelect = (key: string, value: string) => {
    setAnswers(prev => ({ ...prev, [key]: value }))
  }

  const handleMultiSelect = (key: string, value: string, checked: boolean) => {
    setAnswers(prev => {
      const current = prev[key] as string[]
      return {
        ...prev,
        [key]: checked ? [...current, value] : current.filter(v => v !== value),
      }
    })
  }

  const handleCustomText = (key: string, value: string) => {
    setCustomTexts(prev => ({ ...prev, [key]: value }))
  }

  /** Check if a question is answered (selected option or non-empty custom text) */
  const isAnswered = (index: number): boolean => {
    const key = toKey(index)
    const q = questions[index]
    const custom = customTexts[key]?.trim()
    if (q.multiSelect) {
      return (answers[key] as string[]).length > 0 || !!custom
    }
    return answers[key] !== '' || !!custom
  }

  const unansweredCount = questions.filter((_, i) => !isAnswered(i)).length
  const allAnswered = unansweredCount === 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Build final answers: for single-select, use selection or custom text;
    // for multi-select, append custom text to selections
    const final: Record<string, string | string[]> = {}
    questions.forEach((q, i) => {
      const key = toKey(i)
      const custom = customTexts[key]?.trim()
      if (q.multiSelect) {
        const selected = [...(answers[key] as string[])]
        if (custom) selected.push(custom)
        final[key] = selected
      } else {
        // Single-select: option takes priority; fall back to custom text
        final[key] = (answers[key] as string) || custom || ''
      }
    })
    onSubmit(final)
  }

  const showTabs = questions.length > 1

  const renderQuestion = (q: Question, qIndex: number) => {
    const key = toKey(qIndex)
    const hasSingleSelection = !q.multiSelect && answers[key] !== ''

    return (
      <div key={qIndex} className="space-y-2">
        {q.header && (
          <span className="inline-block text-xs font-medium text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
            {q.header}
          </span>
        )}
        <p className="text-sm text-gray-200 font-medium">{q.question}</p>

        {/* Options */}
        <div className="space-y-1.5 mt-2">
          {q.options.map((option, oIndex) => {
            const inputId = `q${qIndex}-o${oIndex}`
            if (q.multiSelect) {
              const selected = (answers[key] as string[]).includes(option.label)
              return (
                <label
                  key={oIndex}
                  htmlFor={inputId}
                  className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                    selected
                      ? 'bg-blue-500/20 border-blue-500/50'
                      : 'bg-gray-900/50 border-gray-700 hover:border-gray-600'
                  }`}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={selected}
                    onChange={e => handleMultiSelect(key, option.label, e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500/50 bg-gray-800"
                  />
                  <div className="flex-1">
                    <div className="text-sm text-gray-200">{option.label}</div>
                    {option.description && (
                      <div className="text-xs text-gray-500 mt-0.5">{option.description}</div>
                    )}
                  </div>
                </label>
              )
            } else {
              const selected = answers[key] === option.label
              return (
                <label
                  key={oIndex}
                  htmlFor={inputId}
                  className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                    selected
                      ? 'bg-blue-500/20 border-blue-500/50'
                      : 'bg-gray-900/50 border-gray-700 hover:border-gray-600'
                  }`}
                >
                  <input
                    id={inputId}
                    type="radio"
                    name={`question-${qIndex}`}
                    checked={selected}
                    onChange={() => handleSingleSelect(key, option.label)}
                    className="mt-0.5 w-4 h-4 border-gray-600 text-blue-500 focus:ring-blue-500/50 bg-gray-800"
                  />
                  <div className="flex-1">
                    <div className="text-sm text-gray-200">{option.label}</div>
                    {option.description && (
                      <div className="text-xs text-gray-500 mt-0.5">{option.description}</div>
                    )}
                  </div>
                </label>
              )
            }
          })}
        </div>

        {/* Custom input */}
        <div className="mt-3">
          <input
            type="text"
            value={customTexts[key] || ''}
            onChange={e => handleCustomText(key, e.target.value)}
            disabled={hasSingleSelection}
            placeholder={
              q.multiSelect
                ? '输入自定义内容（追加到已选项）'
                : hasSingleSelection
                  ? '已选择选项，自定义输入不采用'
                  : '或输入自定义内容'
            }
            className={`w-full px-3 py-2 text-sm rounded-lg border transition-colors ${
              hasSingleSelection
                ? 'bg-gray-900/30 border-gray-800 text-gray-600 cursor-not-allowed'
                : 'bg-gray-900/50 border-gray-700 text-gray-200 placeholder-gray-500 focus:border-blue-500/50 focus:outline-none'
            }`}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 my-3">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-5 h-5 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <span className="text-sm font-medium text-gray-300">Claude 需要更多信息</span>
      </div>

      {/* Tabs (only for multiple questions) */}
      {showTabs && (
        <div className="relative flex items-center mb-4">
          {canScrollLeft && (
            <button
              type="button"
              onClick={() => scrollTabs('left')}
              className="absolute left-0 z-10 w-7 h-7 flex items-center justify-center bg-gray-800/90 border border-gray-700 rounded-md text-gray-400 hover:text-gray-200 shadow-md"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}

          <div
            ref={tabsRef}
            className="flex gap-1 overflow-x-auto scrollbar-none px-1"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {questions.map((q, i) => {
              const answered = isAnswered(i)
              const active = activeTab === i
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveTab(i)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
                    active
                      ? 'bg-blue-600 text-white'
                      : answered
                        ? 'bg-gray-700/60 text-emerald-400 hover:bg-gray-700'
                        : 'bg-gray-900/50 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                  }`}
                >
                  {answered && !active && <Check className="w-3 h-3" />}
                  {tabLabel(q, i)}
                </button>
              )
            })}
          </div>

          {canScrollRight && (
            <button
              type="button"
              onClick={() => scrollTabs('right')}
              className="absolute right-0 z-10 w-7 h-7 flex items-center justify-center bg-gray-800/90 border border-gray-700 rounded-md text-gray-400 hover:text-gray-200 shadow-md"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Question content */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {showTabs ? renderQuestion(questions[activeTab], activeTab) : renderQuestion(questions[0], 0)}

        {/* Footer */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={!allAnswered}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            提交
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-gray-400 hover:text-gray-200 text-sm transition-colors"
            >
              取消
            </button>
          )}
          {!allAnswered && (
            <span className="flex items-center gap-1 text-xs text-amber-400">
              <CircleAlert className="w-3.5 h-3.5" />
              还有 {unansweredCount} 个问题未回答
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
