import { EventEmitter } from 'node:events'
import type { CoreEventMap, AgentInterface, TurnSubmitParams, SdkInitInfo } from '../types/index.js'
import { ProjectManager } from './project.js'
import { SessionManager } from './session.js'
import { TurnManager } from './turn.js'
import { AgentManager } from './agent-manager.js'
import { ThreadManager } from './thread.js'
import { MessageRouter } from './message-router.js'

export class CoreEngine extends EventEmitter {
  readonly projects: ProjectManager
  readonly sessions: SessionManager
  readonly turns: TurnManager
  readonly agents: AgentManager
  readonly threads: ThreadManager
  readonly router: MessageRouter

  constructor(private agent: AgentInterface) {
    super()
    this.setMaxListeners(50) // Many subscribers expected
    this.projects = new ProjectManager()
    this.sessions = new SessionManager()
    this.turns = new TurnManager(this.agent, this.sessions, this)
    this.agents = new AgentManager(this.projects)
    this.threads = new ThreadManager()
    this.router = new MessageRouter(this.threads, this.sessions, this.agents, this)
  }

  async init(): Promise<void> {
    await this.projects.load()
    await this.sessions.load()
    await this.agents.load()
    await this.agents.ensureSystemAgent()
    await this.threads.load()
  }

  /** Submit a Turn — Gateway and CronScheduler both call this */
  async submitTurn(params: TurnSubmitParams): Promise<string> {
    return this.turns.submit(params)
  }

  /** Probe SDK for available tools/models — resolves provider config for proper auth */
  async probeSdk(projectId: string): Promise<SdkInitInfo> {
    const projectPath = this.projects.getPath(projectId)
    if (!projectPath) throw new Error('Project path not found')

    const defaultProviderId = this.projects.getDefaultProvider(projectId)
    const providerConfig = this.projects.resolveProviderConfig(defaultProviderId)
    let resolvedModel: string | undefined
    if (providerConfig) {
      resolvedModel = providerConfig.modelId
        || (providerConfig.provider === 'custom' ? providerConfig.name : undefined)
    } else {
      resolvedModel = defaultProviderId
    }
    const env = providerConfig ? this.projects.buildProviderEnv(providerConfig) : undefined

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
