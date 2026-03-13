// Push MCP tool definitions for the Claude Agent SDK.

import { z } from 'zod/v4'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { isApnsConfigured, broadcastPush } from './apns.js'
import { getDeviceTokens } from './store.js'

export const pushTools = [
  tool(
    'push_send',
    `Send a push notification to the user's iOS device.

Use this tool when:
- A cron/scheduled task fires and needs to notify the user
- The user explicitly asks to be notified about something
- A reminder needs to be delivered

The notification will be sent to all registered iOS devices via Apple Push Notification service.`,
    {
      title: z.string().describe('Notification title (short, e.g. "Reminder" or "Task Complete")'),
      body: z.string().describe('Notification body text'),
    },
    async (input) => {
      if (!isApnsConfigured()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Push notifications not configured. Set APNS_KEY (or APNS_KEY_PATH), APNS_KEY_ID, APNS_TEAM_ID, and APNS_BUNDLE_ID environment variables.',
            },
          ],
          isError: true,
        }
      }

      const tokens = getDeviceTokens()
      if (tokens.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No iOS devices registered for push notifications.',
            },
          ],
          isError: true,
        }
      }

      const results = await broadcastPush(tokens, input.title, input.body)
      const sent = results.filter((r) => r.success).length
      const failed = results.filter((r) => !r.success)

      let text = `Push notification sent to ${sent}/${tokens.length} device(s).`
      if (failed.length > 0) {
        text += `\nFailed: ${failed.map((f) => f.reason).join(', ')}`
      }

      return {
        content: [{ type: 'text' as const, text }],
      }
    },
  ),
]
