import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ActivityMutation } from '../contracts.js'
import {
  activityBadgeCount,
  deriveInboxRows,
  rowsForFilter,
  type InboxCategory,
  type InboxFilter,
  type InboxRow,
} from './model.js'
import type { ActivityInboxFace } from './slots.js'

const css = {
  actions: 'activityInbox-actions',
  badge: 'activityInbox-badge',
  body: 'activityInbox-body',
  empty: 'activityInbox-empty',
  error: 'activityInbox-error',
  filters: 'activityInbox-filters',
  header: 'activityInbox-header',
  headerActions: 'activityInbox-headerActions',
  headerTitle: 'activityInbox-headerTitle',
  layer: 'activityInbox-layer',
  meta: 'activityInbox-meta',
  note: 'activityInbox-note',
  panel: 'activityInbox-panel',
  parent: 'activityInbox-parent',
  rail: 'activityInbox-rail',
  close: 'activityInbox-close',
  closeIcon: 'activityInbox-closeIcon',
  refresh: 'activityInbox-refresh',
  row: 'activityInbox-row',
  rowHead: 'activityInbox-rowHead',
  rows: 'activityInbox-rows',
  status: 'activityInbox-status',
  time: 'activityInbox-time',
  trigger: 'activityInbox-trigger',
  triggerLabel: 'activityInbox-triggerLabel',
  warning: 'activityInbox-warning',
} as const

export type ActivityInboxPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<ActivityInboxFace>

const FILTERS: readonly { id: InboxFilter; label: string }[] = [
  { id: 'needs-action', label: 'Needs action' },
  { id: 'failed', label: 'Failed' },
  { id: 'completed', label: 'Completed' },
  { id: 'following', label: 'Following' },
  { id: 'archived', label: 'Archived' },
]

const CATEGORY_LABEL: Record<InboxCategory, string> = {
  'needs-action': 'Needs action',
  failed: 'Failed',
  completed: 'Completed',
  running: 'Running',
  idle: 'Idle',
}

function relativeTime(timestamp: number, now: number): string {
  if (timestamp <= 0) return ''
  const delta = timestamp - now
  const abs = Math.abs(delta)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60_000) return formatter.format(Math.round(delta / 1_000), 'second')
  if (abs < 60 * 60_000) return formatter.format(Math.round(delta / 60_000), 'minute')
  if (abs < 24 * 60 * 60_000) return formatter.format(Math.round(delta / (60 * 60_000)), 'hour')
  return formatter.format(Math.round(delta / (24 * 60 * 60_000)), 'day')
}

function BellIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
      <path d="M10 2.5a5 5 0 0 0-5 5v2.2c0 .8-.27 1.58-.77 2.2L3.2 13.2a1 1 0 0 0 .78 1.63h12.04a1 1 0 0 0 .78-1.63l-1.03-1.3a3.5 3.5 0 0 1-.77-2.2V7.5a5 5 0 0 0-5-5Zm-1.8 13.7a2 2 0 0 0 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function RowActions({ row, busy, mutate, open }: {
  row: InboxRow
  busy: boolean
  mutate: (mutation: ActivityMutation) => void
  open: () => void
}) {
  return (
    <div className={css.actions}>
      <button type="button" disabled={row.openTargetId === undefined} onClick={open} data-activity-open={row.sessionId}>
        {row.openTargetId === row.sessionId ? 'Open task' : 'Open parent'}
      </button>
      {row.pendingKind === undefined && row.sourceSeq >= 0 && !row.archived && (
        <button
          type="button"
          disabled={busy}
          onClick={() => { mutate({
            action: row.reviewed ? 'mark-unreviewed' : 'mark-reviewed',
            sessionId: row.sessionId,
            sourceSeq: row.sourceSeq,
          }) }}
        >{row.reviewed ? 'Unread' : 'Reviewed'}</button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => { mutate({ action: 'set-followed', sessionId: row.sessionId, followed: !row.followed }) }}
      >{row.followed ? 'Unfollow' : 'Follow'}</button>
      {!row.archived && (
        row.snoozedUntil === undefined
          ? <button
              type="button"
              disabled={busy}
              onClick={() => { mutate({
                action: 'snooze', sessionId: row.sessionId, sourceSeq: row.sourceSeq,
                until: Date.now() + 60 * 60 * 1_000,
              }) }}
            >Snooze 1h</button>
          : <button type="button" disabled={busy} onClick={() => { mutate({ action: 'unsnooze', sessionId: row.sessionId }) }}>Unsnooze</button>
      )}
      {row.sourceSeq >= 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => { mutate({
            action: row.archived ? 'restore' : 'archive',
            sessionId: row.sessionId,
            sourceSeq: row.sourceSeq,
          }) }}
        >{row.archived ? 'Restore' : 'Archive'}</button>
      )}
    </div>
  )
}

export function ActivityInboxPanel({
  wide, useSessions, useInbox, onRefresh, onMutate, onOpenSession,
}: ActivityInboxPanelProps) {
  const inbox = useInbox(value => value)
  const sessions = useSessions(value => value)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<InboxFilter>('needs-action')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [actionError, setActionError] = useState<string>()
  const [clock, setClock] = useState(() => Date.now())
  const rows = useMemo(() => deriveInboxRows(inbox.server, sessions, clock), [inbox.server, sessions, clock])
  const visible = useMemo(() => rowsForFilter(rows, filter), [rows, filter])
  const badge = activityBadgeCount(rows)

  useEffect(() => {
    if (!open) return
    setClock(Date.now())
    onRefresh()
    const clockTimer = window.setInterval(() => { setClock(Date.now()) }, 30_000)
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', keydown)
    return () => {
      window.clearInterval(clockTimer)
      window.removeEventListener('keydown', keydown)
    }
  }, [onRefresh, open])

  const mutate = (mutation: ActivityMutation): void => {
    if (busy.has(mutation.sessionId)) return
    setBusy(current => new Set(current).add(mutation.sessionId))
    setActionError(undefined)
    void onMutate(mutation).then((result) => {
      if (!result.ok) setActionError(result.message)
    }).finally(() => {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(mutation.sessionId)
        return next
      })
    })
  }

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && (
        <section className={css.panel} aria-label="Activity inbox" data-activity-inbox-panel>
          <header className={css.header}>
            <div className={css.headerTitle}>
              <h2>Activity</h2>
              <p>Exact task outcomes—no AI-generated summaries.</p>
            </div>
            <div className={css.headerActions}>
              <button type="button" className={css.refresh} onClick={onRefresh} disabled={inbox.loading}>
                {inbox.loading ? 'Refreshing…' : 'Refresh'}
              </button>
              <button
                type="button"
                className={css.close}
                aria-label="Close activity inbox"
                data-activity-inbox-close
                onClick={() => { setOpen(false) }}
              >
                <span className={css.closeIcon} aria-hidden="true">×</span>
                <span>Close</span>
              </button>
            </div>
          </header>
          <nav className={css.filters} aria-label="Activity filters">
            {FILTERS.map(item => {
              const count = rowsForFilter(rows, item.id).length
              return (
                <button
                  type="button"
                  key={item.id}
                  data-active={filter === item.id || undefined}
                  data-activity-filter={item.id}
                  onClick={() => { setFilter(item.id) }}
                >{item.label}<span>{count}</span></button>
              )
            })}
          </nav>
          <div className={css.body}>
            {inbox.error !== undefined && <p className={css.error} role="alert">{inbox.error}</p>}
            {actionError !== undefined && <p className={css.error} role="alert">{actionError}</p>}
            {inbox.server !== undefined && !inbox.server.backfillReady && (
              <p className={css.note}>Indexing durable session history…</p>
            )}
            {inbox.server !== undefined && inbox.server.backfillFailures > 0 && (
              <p className={css.warning}>{`${inbox.server.backfillFailures} session log(s) could not be indexed.`}</p>
            )}
            {inbox.server === undefined && inbox.loading && <p className={css.note}>Loading activity…</p>}
            {inbox.server !== undefined && visible.length === 0 && <p className={css.empty}>Nothing in this view.</p>}
            {visible.length > 0 && (
              <ul className={css.rows}>
                {visible.map(row => (
                  <li
                    key={row.sessionId}
                    className={css.row}
                    data-activity-session={row.sessionId}
                    data-activity-category={row.category}
                    data-reviewed={row.reviewed || undefined}
                  >
                    <div className={css.rowHead}>
                      <span className={css.status}>{CATEGORY_LABEL[row.category]}</span>
                      <span className={css.time}>{relativeTime(row.occurredAt, clock)}</span>
                    </div>
                    <strong>{row.title}</strong>
                    {row.parentTitle !== undefined && <span className={css.parent}>{`Subagent of ${row.parentTitle}`}</span>}
                    <p>{row.detail}</p>
                    <div className={css.meta}>
                      {row.reviewed && <span>Reviewed</span>}
                      {row.followed && <span>Following</span>}
                      {row.snoozedUntil !== undefined && <span>{`Snoozed until ${new Date(row.snoozedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span>}
                      {row.reasonCode !== undefined && <span>{`Evidence: event #${row.sourceSeq}`}</span>}
                    </div>
                    <RowActions
                      row={row}
                      busy={busy.has(row.sessionId)}
                      mutate={mutate}
                      open={() => { if (row.openTargetId !== undefined) onOpenSession(row.sessionId) }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      <button
        type="button"
        className={css.trigger}
        aria-label={badge === 0 ? 'Open activity inbox' : `Open activity inbox, ${badge} item${badge === 1 ? '' : 's'} need attention`}
        aria-expanded={open}
        data-activity-inbox-trigger
        data-activity-badge={badge}
        data-active={badge > 0 || undefined}
        onClick={() => { setOpen(value => !value) }}
      >
        <BellIcon />
        {wide && <span className={css.triggerLabel}>Activity</span>}
        {badge > 0 && <span className={css.badge}>{badge > 99 ? '99+' : badge}</span>}
      </button>
    </div>
  )
}
