// Push MCP tool definitions for the Claude Agent SDK (server-v2)

import { z } from 'zod/v4'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { isApnsConfigured, broadcastPush } from '../../../push/apns.js'
import { getLastActiveDeviceToken } from '../../../push/store.js'

export const tools = [
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

      const token = getLastActiveDeviceToken()
      if (!token) {
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

      const results = await broadcastPush([token], input.title, input.body)
      const result = results[0]

      const text = result?.success
        ? `Push notification sent to device ${token.slice(0, 8)}...`
        : `Push notification failed: ${result?.reason}`

      return {
        content: [{ type: 'text' as const, text }],
      }
    },
  ),
]
