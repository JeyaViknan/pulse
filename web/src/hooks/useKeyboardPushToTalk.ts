import { useEffect, useRef } from 'react'
import { SPEAKER_KEY } from '../lib/speakers'
import type { Speaker } from '../types/pulse'

interface Options {
  enabled: boolean
  onPress: (speaker: Speaker) => void
  onRelease: (speaker: Speaker) => void
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

/** Keys typed into a text field must never trigger push-to-talk. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)
}

function speakerForKey(key: string): Speaker | null {
  const pressed = key.toLowerCase()
  if (pressed === SPEAKER_KEY.dealer) return 'dealer'
  if (pressed === SPEAKER_KEY.customer) return 'customer'
  return null
}

/**
 * Hold F for the dealer, J for the customer. Only one key is honoured at a time: a second
 * key pressed while the first is held is ignored, and only the held key's release stops it.
 * Losing window focus releases the held key so a recording cannot get stuck on.
 */
export function useKeyboardPushToTalk({ enabled, onPress, onRelease }: Options): void {
  const handlers = useRef({ onPress, onRelease })

  useEffect(() => {
    handlers.current = { onPress, onRelease }
  })

  useEffect(() => {
    if (!enabled) return undefined
    let held: Speaker | null = null

    const release = () => {
      if (held === null) return
      const speaker = held
      held = null
      handlers.current.onRelease(speaker)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTextEntry(event.target)) return
      const speaker = speakerForKey(event.key)
      if (speaker === null) return
      event.preventDefault()
      if (event.repeat || held !== null) return
      held = speaker
      handlers.current.onPress(speaker)
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (speakerForKey(event.key) === held) release()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', release)
      release()
    }
  }, [enabled])
}
