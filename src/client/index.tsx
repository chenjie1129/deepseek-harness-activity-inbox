/** DeepSeek Harness browser half: root sidebar action and deterministic inbox panel. */

import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ACTIVITY_INBOX_REMOTE_CONTRIBUTION } from '../remote.js'
import { ActivityInboxPanel } from './ActivityInboxPanel.js'
import {
  createActivityInboxSource,
  createRemoteActivityInboxTransport,
  type ActivityInboxRemoteNamespace,
} from './source.js'
import type { ActivityInboxFace } from './slots.js'
import styles from './styles.css'

export const inject = ['slots', 'connection', 'sessions']

interface ActivityInboxRemoteClient {
  $mount(contribution: typeof ACTIVITY_INBOX_REMOTE_CONTRIBUTION): Promise<() => Promise<void>>
}

export async function apply(ctx: ClientContext): Promise<(() => Promise<void>) | undefined> {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  // Host and Client packages intentionally share the `sessions` service name.
  // This bundle resolves the browser service at runtime; the explicit cast
  // keeps the combined Host+Client declaration program from choosing the Host face.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const remote = ctx.get('remote') as unknown as ActivityInboxRemoteClient | undefined
  let disposeRemote: (() => Promise<void>) | undefined
  let transport: ConnectionHandle | ReturnType<typeof createRemoteActivityInboxTransport> = connection
  if (typeof remote?.$mount === 'function') {
    disposeRemote = await remote.$mount(ACTIVITY_INBOX_REMOTE_CONTRIBUTION)
    const namespace = ctx.get('remote.activityInbox') as ActivityInboxRemoteNamespace | undefined
    if (namespace === undefined) throw new Error('Activity Inbox Remote namespace did not mount.')
    transport = createRemoteActivityInboxTransport(namespace)
  }
  const source = createActivityInboxSource(transport, (error) => {
    console.error('[activity-inbox] refresh failed:', error)
  })

  ctx.effect(() => {
    const element = document.createElement('style')
    element.dataset.dshActivityInbox = 'v1'
    element.textContent = styles
    document.head.append(element)
    return () => { element.remove() }
  }, 'activity-inbox: styles')

  ctx.on('connection/reset', () => {
    source.reset()
    source.refresh()
  })

  ctx.effect(() => {
    const refreshVisible = (): void => { if (document.visibilityState === 'visible') source.refresh() }
    const timer = window.setInterval(refreshVisible, 5_000)
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, 'activity-inbox: refresh on focus and interval')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'activity-inbox',
    inject: (): ActivityInboxFace => ({
      hooks: { inbox: source },
      onRefresh: () => { source.refresh() },
      onMutate: mutation => source.mutate(mutation),
      onOpenSession(sessionId) {
        const id = sessionId as SessionId
        const address = sessions.subagentAddress(id)
        if (address !== undefined) {
          sessions.openSubagent(address)
          return
        }
        const snapshot = sessions.list.getSnapshot()
        if (snapshot.ids.includes(id)) {
          sessions.open(id)
          return
        }
        const activity = source.getSnapshot().server?.activities.find(row => row.sessionId === sessionId)
        const parent = activity?.parentSessionId as SessionId | undefined
        if (parent !== undefined && snapshot.ids.includes(parent)) sessions.open(parent)
      },
    }),
  }, ActivityInboxPanel))

  source.refresh()
  return disposeRemote
}

export { ActivityInboxPanel } from './ActivityInboxPanel.js'
export { activityBadgeCount, deriveInboxRows, rowsForFilter } from './model.js'
export { createActivityInboxSource } from './source.js'
