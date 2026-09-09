import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import {
  mergeRuntimeState,
  parseRuntimeState,
  type DesktopRuntimeState,
} from './presence'

const INITIAL_STATE: DesktopRuntimeState = {
  phase: 'connecting',
  attempt: 0,
}

export function useDesktopPresence(): DesktopRuntimeState {
  const [state, setState] = useState<DesktopRuntimeState>(INITIAL_STATE)

  useEffect(() => {
    let active = true
    let unlisten: UnlistenFn | undefined

    const accept = (value: unknown): void => {
      if (!active) return
      const parsed = parseRuntimeState(value)
      if (parsed !== undefined) {
        setState(current => mergeRuntimeState(current, parsed))
      }
    }

    void invoke<unknown>('get_runtime_state')
      .then(accept)
      .catch(error => {
        if (!active) return
        setState({
          phase: 'offline',
          attempt: 0,
          lastError: error instanceof Error ? error.message : String(error),
        })
      })

    void listen<unknown>('presence://state', event => {
      accept(event.payload)
    }).then(dispose => {
      if (active) unlisten = dispose
      else dispose()
    })

    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  return state
}
