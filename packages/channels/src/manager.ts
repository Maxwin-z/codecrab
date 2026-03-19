// ChannelManager — lifecycle management, context creation, project resolution

import type {
  ChannelPlugin,
  ChannelConfig,
  ChannelContext,
  ChannelEngineContext,
  ChannelPromptParams,
  ChannelQueryResult,
  ChannelProjectMapping,
  ConversationState,
  ChannelDefinition,
} from './types.js'
import { channelRegistry } from './index.js'
import * as store from './store.js'
import { executeChannelQuery } from './query.js'

export class ChannelManager {
  private engine: ChannelEngineContext
  private instances = new Map<string, { plugin: ChannelPlugin; config: ChannelConfig }>()

  constructor(engine: ChannelEngineContext) {
    this.engine = engine
  }

  /** Restore all enabled channel instances from disk on server startup */
  async restoreChannels(): Promise<void> {
    const configs = store.loadConfigs()
    let restored = 0

    for (const config of configs) {
      if (!config.enabled) continue

      try {
        await this.startInstance(config)
        restored++
      } catch (err) {
        console.error(`[ChannelManager] Failed to restore channel ${config.instanceId}:`, err)
      }
    }

    if (restored > 0) {
      console.log(`[ChannelManager] Restored ${restored} channel instance(s)`)
    }
  }

  /** Create a new channel instance from config */
  createInstance(config: ChannelConfig): void {
    const definition = channelRegistry.get(config.id)
    if (!definition) {
      throw new Error(`Unknown channel type: ${config.id}`)
    }

    store.saveConfig(config)
  }

  /** Start a channel instance */
  async startInstance(config: ChannelConfig): Promise<void> {
    // Stop if already running
    if (this.instances.has(config.instanceId)) {
      await this.stopInstance(config.instanceId)
    }

    const definition = channelRegistry.get(config.id)
    if (!definition) {
      throw new Error(`Unknown channel type: ${config.id}`)
    }

    const plugin = definition.factory(config)
    const context = this.createContext(config, plugin)

    this.instances.set(config.instanceId, { plugin, config })

    try {
      await plugin.start(context)
      console.log(`[ChannelManager] Started channel ${config.instanceId} (${config.id})`)
    } catch (err) {
      this.instances.delete(config.instanceId)
      throw err
    }
  }

  /** Stop a channel instance */
  async stopInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId)
    if (!instance) return

    try {
      await instance.plugin.stop()
    } catch (err) {
      console.error(`[ChannelManager] Error stopping channel ${instanceId}:`, err)
    }

    this.instances.delete(instanceId)
    console.log(`[ChannelManager] Stopped channel ${instanceId}`)
  }

  /** Stop all running channel instances */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.instances.keys())
    await Promise.allSettled(ids.map(id => this.stopInstance(id)))
  }

  /** Get a running plugin instance */
  getInstance(instanceId: string): { plugin: ChannelPlugin; config: ChannelConfig } | undefined {
    return this.instances.get(instanceId)
  }

  /** List all instances with their runtime status */
  listInstances(): Array<{ config: ChannelConfig; status: string; healthy?: boolean }> {
    const configs = store.loadConfigs()
    return configs.map(config => {
      const instance = this.instances.get(config.instanceId)
      return {
        config,
        status: instance?.plugin.status || 'stopped',
        healthy: undefined, // Populated on demand via health check
      }
    })
  }

  /** Delete a channel instance (stops if running, removes config) */
  async deleteInstance(instanceId: string): Promise<boolean> {
    await this.stopInstance(instanceId)
    return store.deleteConfig(instanceId)
  }

  /** Get conversations for an instance */
  getConversations(instanceId: string): ConversationState[] {
    const conversations = store.loadConversations(instanceId)
    return Array.from(conversations.values())
  }

  /** Create the ChannelContext that is injected into plugins */
  private createContext(config: ChannelConfig, plugin: ChannelPlugin): ChannelContext {
    const engine = this.engine
    const instanceId = config.instanceId

    // Load conversation states for this instance
    const conversations = store.loadConversations(instanceId)

    // Map from projectId to clientState for resolving interactive flows
    const activeClientStates = new Map<string, ReturnType<ChannelEngineContext['createClientState']>>()

    const context: ChannelContext = {
      submitPrompt: async (params: ChannelPromptParams): Promise<ChannelQueryResult> => {
        // Get or create conversation state
        let conversation = conversations.get(params.conversationId)
        if (!conversation || conversation.projectId !== params.projectId) {
          conversation = {
            conversationId: params.conversationId,
            sessionId: `channel-${config.id}-${params.conversationId}-${Date.now()}`,
            projectId: params.projectId,
            lastActivityAt: Date.now(),
          }
          conversations.set(params.conversationId, conversation)
          store.saveConversations(instanceId, conversations)
        }

        conversation.lastActivityAt = Date.now()
        store.saveConversations(instanceId, conversations)

        const result = await executeChannelQuery(params, plugin, config, engine, conversation)
        return result
      },

      respondToQuestion: (projectId: string, toolId: string, answers: Record<string, string | string[]>): boolean => {
        // Find active client state for this project
        // The client state is created during query execution
        // We need to find it by the channel client ID pattern
        for (const [convId, conv] of conversations) {
          if (conv.projectId === projectId) {
            const channelClientId = `channel-${config.instanceId}-${convId}`
            const clientState = activeClientStates.get(channelClientId)
            if (clientState) {
              const resolved = engine.handleQuestionResponse(clientState, answers)
              if (resolved) {
                // Resume timeout after answering
                const runningQuery = (engine.queryQueue as any).getRunningQuery?.(projectId)
                if (runningQuery) {
                  engine.queryQueue.resumeTimeout(runningQuery.id)
                }
              }
              return resolved
            }
          }
        }
        return false
      },

      respondToPermission: (projectId: string, requestId: string, allow: boolean): boolean => {
        for (const [convId, conv] of conversations) {
          if (conv.projectId === projectId) {
            const channelClientId = `channel-${config.instanceId}-${convId}`
            const clientState = activeClientStates.get(channelClientId)
            if (clientState) {
              const resolved = engine.handlePermissionResponse(clientState, requestId, allow)
              if (resolved) {
                const runningQuery = (engine.queryQueue as any).getRunningQuery?.(projectId)
                if (runningQuery) {
                  engine.queryQueue.resumeTimeout(runningQuery.id)
                }
              }
              return resolved
            }
          }
        }
        return false
      },

      resolveProject: async (externalUserId: string, conversationId?: string): Promise<ChannelProjectMapping | null> => {
        // 1. Conversation-level override (from /project command)
        if (conversationId) {
          const conv = conversations.get(conversationId)
          if (conv?.projectId) {
            const projects = await engine.listProjects()
            const project = projects.find(p => p.id === conv.projectId)
            if (project) {
              return {
                projectId: project.id,
                projectName: project.name,
                permissionMode: 'default',
              }
            }
          }
        }

        // 2-4. Mapping rules
        for (const rule of config.projectMapping) {
          // conversationIds exact match
          if (conversationId && rule.conversationIds?.includes(conversationId)) {
            const projects = await engine.listProjects()
            const project = projects.find(p => p.id === rule.projectId)
            if (project) {
              return {
                projectId: project.id,
                projectName: project.name,
                permissionMode: rule.permissionMode || 'default',
              }
            }
          }

          // externalUserIds exact match
          if (rule.externalUserIds?.includes(externalUserId)) {
            const projects = await engine.listProjects()
            const project = projects.find(p => p.id === rule.projectId)
            if (project) {
              return {
                projectId: project.id,
                projectName: project.name,
                permissionMode: rule.permissionMode || 'default',
              }
            }
          }

          // regex pattern match
          if (rule.pattern) {
            const regex = new RegExp(rule.pattern)
            if (regex.test(externalUserId) || (conversationId && regex.test(conversationId))) {
              const projects = await engine.listProjects()
              const project = projects.find(p => p.id === rule.projectId)
              if (project) {
                return {
                  projectId: project.id,
                  projectName: project.name,
                  permissionMode: rule.permissionMode || 'default',
                }
              }
            }
          }
        }

        // 5. Default project fallback
        if (config.defaultProjectId) {
          const projects = await engine.listProjects()
          const project = projects.find(p => p.id === config.defaultProjectId)
          if (project) {
            return {
              projectId: project.id,
              projectName: project.name,
              permissionMode: 'default',
            }
          }
        }

        return null
      },

      abortQuery: (projectId: string): boolean => {
        engine.queryQueue.abortRunning(projectId)
        return true
      },

      log: (level: 'info' | 'warn' | 'error', message: string): void => {
        const prefix = `[Channel:${instanceId}]`
        if (level === 'error') {
          console.error(prefix, message)
        } else if (level === 'warn') {
          console.warn(prefix, message)
        } else {
          console.log(prefix, message)
        }
      },

      loadState: async (): Promise<Record<string, unknown>> => {
        return store.loadPluginState(instanceId)
      },

      saveState: async (state: Record<string, unknown>): Promise<void> => {
        store.savePluginState(instanceId, state)
      },
    }

    return context
  }
}
