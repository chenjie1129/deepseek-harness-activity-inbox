/** Approval waterfall observer that records waiting state without deciding it. */

import { randomUUID } from 'node:crypto'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ActivityInboxStore } from '../store.js'

export async function observeApprovalPresence(
  store: ActivityInboxStore,
  request: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
  fallbackId = randomUUID(),
): Promise<ApprovalOutcome> {
  const key = `a:${request.callId === undefined ? fallbackId : String(request.callId)}`
  const sessionId = String(request.agent.id)
  store.beginPending(sessionId, key, 'approval')
  try {
    return await next()
  } finally {
    store.endPending(sessionId, key)
  }
}
