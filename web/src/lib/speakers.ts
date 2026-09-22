import type { Speaker } from '../types/pulse'

export const SPEAKERS: readonly Speaker[] = ['dealer', 'customer']

export const SPEAKER_LABEL: Record<Speaker, string> = {
  dealer: 'Dealer',
  customer: 'Customer',
}

export const SPEAKER_INITIAL: Record<Speaker, string> = {
  dealer: 'D',
  customer: 'C',
}

/** Physical key held for each speaker's push-to-talk. */
export const SPEAKER_KEY: Record<Speaker, string> = {
  dealer: 'f',
  customer: 'j',
}

export function otherSpeaker(speaker: Speaker): Speaker {
  return speaker === 'dealer' ? 'customer' : 'dealer'
}
