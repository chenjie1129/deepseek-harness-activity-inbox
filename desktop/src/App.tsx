import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  ExternalLink,
  EyeOff,
  GripHorizontal,
  Pause,
  Pin,
  PinOff,
  Play,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  loadDesktopPreferences,
  projectionForRuntime,
  saveDesktopPreferences,
  type DesktopPreferences,
} from './presence'
import { useDesktopPresence } from './useDesktopPresence'

interface WindowSettings {
  alwaysOnTop: boolean
  clickThrough: boolean
}

function App() {
  const runtime = useDesktopPresence()
  const projection = useMemo(() => projectionForRuntime(runtime), [runtime])
  const [preferences, setPreferences] = useState<DesktopPreferences>(() => (
    loadDesktopPreferences(globalThis.localStorage)
  ))
  const [commandError, setCommandError] = useState<string>()

  const updatePreferences = (next: DesktopPreferences): void => {
    setPreferences(next)
    saveDesktopPreferences(globalThis.localStorage, next)
  }

  useEffect(() => {
    void Promise.all([
      invoke<WindowSettings>('set_always_on_top', {
        enabled: preferences.alwaysOnTop,
      }),
      invoke<WindowSettings>('set_click_through', {
        enabled: preferences.clickThrough,
      }),
    ]).catch(error => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [])

  useEffect(() => {
    let active = true
    let dispose: (() => void) | undefined
    void listen<WindowSettings>('window://settings', event => {
      if (!active) return
      setPreferences(current => {
        const next = {
          ...current,
          alwaysOnTop: event.payload.alwaysOnTop,
          clickThrough: event.payload.clickThrough,
        }
        saveDesktopPreferences(globalThis.localStorage, next)
        return next
      })
    }).then(unlisten => {
      if (active) dispose = unlisten
      else unlisten()
    })
    return () => {
      active = false
      dispose?.()
    }
  }, [])

  const setAlwaysOnTop = async (): Promise<void> => {
    try {
      const next = await invoke<WindowSettings>('set_always_on_top', {
        enabled: !preferences.alwaysOnTop,
      })
      setCommandError(undefined)
      updatePreferences({ ...preferences, ...next })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  const enableClickThrough = async (): Promise<void> => {
    try {
      const next = await invoke<WindowSettings>('set_click_through', {
        enabled: true,
      })
      setCommandError(undefined)
      updatePreferences({ ...preferences, ...next })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  const armSnap = (): void => {
    void invoke('arm_snap').catch(error => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }

  const toggleDetails = (): void => {
    updatePreferences({
      ...preferences,
      detailsOpen: !preferences.detailsOpen,
    })
  }

  const toggleAnimation = (): void => {
    updatePreferences({
      ...preferences,
      animationsEnabled: !preferences.animationsEnabled,
    })
  }

  return (
    <main
      className="desktopPet"
      data-state={projection.state}
      data-track={projection.track}
      data-paused={!preferences.animationsEnabled || undefined}
    >
      <nav className="desktopPet-toolbar" aria-label="Activity Pet controls">
        <span
          className="desktopPet-drag"
          data-tauri-drag-region
          role="button"
          tabIndex={0}
          aria-label="Drag Activity Pet"
          title="Drag Activity Pet"
          onPointerDown={armSnap}
        >
          <GripHorizontal size={15} />
        </span>
        <button
          type="button"
          aria-pressed={preferences.alwaysOnTop}
          aria-label={preferences.alwaysOnTop ? 'Disable always on top' : 'Enable always on top'}
          title={preferences.alwaysOnTop ? 'Disable always on top' : 'Enable always on top'}
          onClick={() => { void setAlwaysOnTop() }}
        >
          {preferences.alwaysOnTop ? <Pin size={15} /> : <PinOff size={15} />}
        </button>
        <button
          type="button"
          aria-label={preferences.animationsEnabled ? 'Pause motion' : 'Resume motion'}
          title={preferences.animationsEnabled ? 'Pause motion' : 'Resume motion'}
          onClick={toggleAnimation}
        >
          {preferences.animationsEnabled ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button
          type="button"
          aria-pressed={preferences.clickThrough}
          aria-label={preferences.clickThrough
            ? 'Click-through enabled'
            : 'Enable click-through'}
          title="Enable click-through; restore interaction from the menu bar"
          onClick={() => { void enableClickThrough() }}
        >
          <EyeOff size={15} />
        </button>
        <button
          type="button"
          aria-label="Open Harness"
          title="Open Harness"
          onClick={() => {
            void invoke('open_harness').catch(error => {
              setCommandError(error instanceof Error ? error.message : String(error))
            })
          }}
        >
          <ExternalLink size={15} />
        </button>
      </nav>

      <button
        type="button"
        className="desktopPet-stage"
        aria-label={`${projection.label}. ${projection.detail}`}
        aria-expanded={preferences.detailsOpen}
        onClick={toggleDetails}
        onDoubleClick={() => {
          void invoke('open_harness').catch(error => {
            setCommandError(error instanceof Error ? error.message : String(error))
          })
        }}
      >
        <span className="desktopPet-shadow" />
        <span className="desktopPet-character" aria-hidden="true">
          <span className="desktopPet-tail" />
          <span className="desktopPet-body" />
          <span className="desktopPet-ear desktopPet-earLeft" />
          <span className="desktopPet-ear desktopPet-earRight" />
          <span className="desktopPet-head">
            <span className="desktopPet-eye desktopPet-eyeLeft" />
            <span className="desktopPet-eye desktopPet-eyeRight" />
            <span className="desktopPet-mouth" />
          </span>
          <span className="desktopPet-spark desktopPet-sparkOne" />
          <span className="desktopPet-spark desktopPet-sparkTwo" />
        </span>
        {projection.attentionCount > 0 && (
          <span className="desktopPet-badge" aria-label={`${projection.attentionCount} items need attention`}>
            {projection.attentionCount > 99 ? '99+' : projection.attentionCount}
          </span>
        )}
      </button>

      <section
        className="desktopPet-status"
        data-open={preferences.detailsOpen || undefined}
        aria-live="polite"
      >
        <span className="desktopPet-statusLine">
          <span className="desktopPet-connection" data-phase={runtime.phase} />
          <strong>{projection.label}</strong>
        </span>
        <span className="desktopPet-detail">
          {commandError ?? runtime.lastError ?? projection.detail}
        </span>
        {preferences.detailsOpen && projection.targetSessionId !== undefined && (
          <span className="desktopPet-evidence">
            {projection.sourceSeq === undefined
              ? 'Live interaction'
              : `Evidence #${projection.sourceSeq}`}
          </span>
        )}
      </section>
    </main>
  )
}

export default App
