import { useEffect, useState } from 'react'
import {
  shouldTransitionImmediately,
  type PetProjection,
} from './model.js'

const SETTLE_DELAY_MS = 300

export interface PetSurfaceProps {
  projection: PetProjection
  animationsPaused: boolean
  compact: boolean
}

/** Small bundled Pet renderer. Semantic state always remains visible as text. */
export function PetSurface({
  projection,
  animationsPaused,
  compact,
}: PetSurfaceProps) {
  const [displayed, setDisplayed] = useState(projection)

  useEffect(() => {
    if (displayed.transitionKey === projection.transitionKey) return
    if (shouldTransitionImmediately(projection.state)) {
      setDisplayed(projection)
      return
    }
    const timer = window.setTimeout(() => { setDisplayed(projection) }, SETTLE_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [displayed.transitionKey, projection])

  return (
    <span
      className="activityPet-surface"
      data-activity-pet
      data-pet-state={displayed.state}
      data-pet-track={displayed.track}
      data-paused={animationsPaused || undefined}
      data-compact={compact || undefined}
      aria-hidden="true"
    >
      <span className="activityPet-avatar" aria-hidden="true">
        <span className="activityPet-ear activityPet-earLeft" />
        <span className="activityPet-ear activityPet-earRight" />
        <span className="activityPet-head">
          <span className="activityPet-eye activityPet-eyeLeft" />
          <span className="activityPet-eye activityPet-eyeRight" />
          <span className="activityPet-mouth" />
        </span>
        <span className="activityPet-body" />
      </span>
      {!compact && (
        <span className="activityPet-copy">
          <span className="activityPet-label">{displayed.label}</span>
          <span className="activityPet-detail">{displayed.detail}</span>
        </span>
      )}
    </span>
  )
}
