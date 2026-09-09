import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityMutation, DesktopPetLifecycleCommand } from '../contracts.js'
import type { ActivityInboxClientSnapshot } from './source.js'

/** Business face injected into the root-scoped sidebar action. */
export interface ActivityInboxFace {
  hooks: {
    inbox: HostObservable<ActivityInboxClientSnapshot>
  }
  onRefresh(): void
  onMutate(mutation: ActivityMutation): Promise<{ ok: true } | { ok: false; message: string }>
  onPetControl(command: DesktopPetLifecycleCommand): Promise<{ ok: true } | { ok: false; message: string }>
  onOpenSession(sessionId: string): void
}
