/** Runtime-only Typert descriptors for Harness 0.1.2-alpha.1 and newer. */

import {
  isActivityInboxSnapshot,
  isActivityMutation,
  type ActivityInboxSnapshot,
  type ActivityMutation,
} from './contracts.js'

export const ACTIVITY_INBOX_REMOTE_PACKAGE = '@chenjie1129/dsh-activity-inbox-plugin'
export const ACTIVITY_INBOX_REMOTE_SERVICE = 'activityInboxRemote'
export const ACTIVITY_INBOX_REMOTE_NAMESPACE = 'activityInbox'

interface RuntimeSchema<T> {
  parse(value: unknown): T
}

function schema<T>(name: string, guard: (value: unknown) => value is T): RuntimeSchema<T> {
  return {
    parse(value: unknown): T {
      if (!guard(value)) throw new TypeError(`Invalid ${name}.`)
      return value
    },
  }
}

const mutationSchema = schema<ActivityMutation>('Activity Inbox mutation', isActivityMutation)
const snapshotSchema = schema<ActivityInboxSnapshot>('Activity Inbox snapshot', isActivityInboxSnapshot)

export const ACTIVITY_INBOX_REMOTE_DESCRIPTORS = [{
  id: `${ACTIVITY_INBOX_REMOTE_PACKAGE}#${ACTIVITY_INBOX_REMOTE_NAMESPACE}/snapshot`,
  service: ACTIVITY_INBOX_REMOTE_SERVICE,
  namespace: ACTIVITY_INBOX_REMOTE_NAMESPACE,
  method: 'snapshot',
  invocation: { kind: 'direct' as const },
  parameters: [],
  result: {
    mode: 'strict' as const,
    typeSymbol: `${ACTIVITY_INBOX_REMOTE_PACKAGE}/contracts#ActivityInboxSnapshot`,
    schema: snapshotSchema,
  },
}, {
  id: `${ACTIVITY_INBOX_REMOTE_PACKAGE}#${ACTIVITY_INBOX_REMOTE_NAMESPACE}/mutate`,
  service: ACTIVITY_INBOX_REMOTE_SERVICE,
  namespace: ACTIVITY_INBOX_REMOTE_NAMESPACE,
  method: 'mutate',
  invocation: { kind: 'direct' as const },
  parameters: [{
    name: 'mutation',
    wire: 'mutation',
    source: 'json' as const,
    codec: {
      mode: 'strict' as const,
      typeSymbol: `${ACTIVITY_INBOX_REMOTE_PACKAGE}/contracts#ActivityMutation`,
      schema: mutationSchema,
    },
  }],
  result: {
    mode: 'strict' as const,
    typeSymbol: `${ACTIVITY_INBOX_REMOTE_PACKAGE}/contracts#ActivityInboxSnapshot`,
    schema: snapshotSchema,
  },
}] as const

/** Host registration consumed directly by the alpha Typert registry. */
export const ACTIVITY_INBOX_HOST_CONTRIBUTION = {
  package: ACTIVITY_INBOX_REMOTE_PACKAGE,
  face: 'host' as const,
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: ACTIVITY_INBOX_REMOTE_DESCRIPTORS,
}

/** Client mount consumed directly by the alpha Remote service. */
export const ACTIVITY_INBOX_REMOTE_CONTRIBUTION = {
  package: ACTIVITY_INBOX_REMOTE_PACKAGE,
  descriptors: ACTIVITY_INBOX_REMOTE_DESCRIPTORS,
}
