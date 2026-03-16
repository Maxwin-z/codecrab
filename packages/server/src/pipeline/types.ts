// Pipeline — Stateless batch processor interface
//
// Unlike EngineAdapter (interactive, session-based, streaming),
// Pipelines are simple input→output transformers with no sessions,
// no tools, and no streaming. Designed for lightweight LLM tasks
// like SOUL evolution and content summarization.

export interface Pipeline<TInput, TOutput> {
  id: string
  name: string
  run(input: TInput): Promise<TOutput>
}
