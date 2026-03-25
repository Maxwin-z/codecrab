import { EventEmitter } from 'node:events'
import type { CoreEventMap, AgentInterface, TurnSubmitParams, SdkInitInfo } from '../types/index.js'
import { ProjectManager } from './project.js'
import { SessionManager } from './session.js'
import { TurnManager } from './turn.js'

export class CoreEngine extends EventEmitter {
  readonly projects: ProjectManager
  readonly sessions: SessionManager
  readonly turns: TurnManager

  constructor(private agent: AgentInterface) {
    super()
    this.setMaxListeners(50) // Many subscribers expected
    this.projects = new ProjectManager()
    this.sessions = new SessionManager()
    this.turns = new TurnManager(this.agent, this.sessions, this)
  }

  async init(): Promise<void> {
    await this.projects.load()
    await this.sessions.load()
  }

  /** Submit a Turn — Gateway and CronScheduler both call this */
  async submitTurn(params: TurnSubmitParams): Promise<string> {
    return this.turns.submit(params)
  }

  /** Probe SDK for available tools/models — resolves model config for proper auth */
  async probeSdk(projectId: string): Promise<SdkInitInfo> {
    const projectPath = this.projects.getPath(projectId)
    if (!projectPath) throw new Error('Project path not found')

    const defaultModel = this.projects.getDefaultModel(projectId)
    const modelConfig = this.projects.resolveModelConfig(defaultModel)
    let resolvedModel: string | undefined
    if (modelConfig) {
      resolvedModel = modelConfig.modelId
        || (modelConfig.provider === 'custom' ? modelConfig.name : undefined)
    } else {
      resolvedModel = defaultModel
    }
    const env = modelConfig ? this.projects.buildModelEnv(modelConfig) : undefined

    return this.agent.probe(projectPath, resolvedModel, env)
  }

  // Typed emit/on wrappers
  override emit<K extends keyof CoreEventMap>(event: K, data: CoreEventMap[K]): boolean {
    return super.emit(event, data)
  }

  override on<K extends keyof CoreEventMap>(event: K, listener: (data: CoreEventMap[K]) => void): this {
    return super.on(event, listener as (...args: any[]) => void)
  }

  override once<K extends keyof CoreEventMap>(event: K, listener: (data: CoreEventMap[K]) => void): this {
    return super.once(event, listener as (...args: any[]) => void)
  }

  override off<K extends keyof CoreEventMap>(event: K, listener: (data: CoreEventMap[K]) => void): this {
    return super.off(event, listener as (...args: any[]) => void)
  }
}
