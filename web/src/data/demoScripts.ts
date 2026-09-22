import type { Speaker } from '../types/pulse'

/**
 * Scripted conversations used by the mock backend.
 *
 * The saved demo sessions in Replay mode are these scripts scored by the mock model, so
 * their values are consistent with what the live interface shows. They are placeholders:
 * SPEC.md §9 requires the final prepared sessions to be recorded from real runs of the
 * trained artefact.
 */
export interface DemoScript {
  name: string
  title: string
  description: string
  turns: ReadonlyArray<{ speaker: Speaker; text: string }>
}

/** Scenario A — successful close. Builds steadily, with one clear turning point. */
export const SUCCESSFUL_CLOSE: DemoScript = {
  name: 'demo-close',
  title: 'Northwind Logistics — successful close',
  description: 'Interest builds steadily; the pilot question is the turning point.',
  turns: [
    { speaker: 'dealer', text: 'Hi Priya, thanks for making time today. I wanted to walk through how teams like yours use our dispatch analytics.' },
    { speaker: 'customer', text: "Sure, though I should say we're only exploring options at this stage." },
    { speaker: 'dealer', text: 'Understood. Most teams start by connecting their existing dispatch system so the data flows in automatically.' },
    { speaker: 'customer', text: "That's interesting. Does it connect to the system we have now?" },
    { speaker: 'dealer', text: "It does. There's a native connector, and onboarding is included in every plan." },
    { speaker: 'customer', text: 'Okay, that sounds good. What would a pilot look like for two of our depots?' },
    { speaker: 'dealer', text: "We'd run a four-week pilot on both depots, and you'd only pay if you decide to continue." },
    { speaker: 'customer', text: 'Budget is approved for this quarter, so the timing works for us.' },
    { speaker: 'dealer', text: "Great. I'll send the pilot agreement over this afternoon." },
  ],
}

/** Scenario B — lost deal. A price objection drops the estimate and it never recovers. */
export const LOST_DEAL: DemoScript = {
  name: 'demo-lost',
  title: 'Crestline Health — lost deal',
  description: 'Early interest, then a price objection the dealer does not address.',
  turns: [
    { speaker: 'dealer', text: "Thanks for joining, Marcus. I'd like to show how we cut reporting time for clinic managers." },
    { speaker: 'customer', text: 'Okay, I have about twenty minutes.' },
    { speaker: 'dealer', text: 'Our dashboards pull from your scheduling system and flag bottlenecks automatically.' },
    { speaker: 'customer', text: "That's interesting, we do struggle with that." },
    { speaker: 'dealer', text: 'For a network your size, the enterprise plan is forty thousand a year.' },
    { speaker: 'customer', text: "That's a lot more than we expected, and it's well over our budget." },
    { speaker: 'dealer', text: 'I understand. The price is fixed for the enterprise tier, unfortunately.' },
    { speaker: 'customer', text: "Then I'm not sure this is a priority right now." },
    { speaker: 'dealer', text: 'Could we set up a follow-up next month?' },
    { speaker: 'customer', text: "Maybe next quarter. We'll circle back if anything changes." },
  ],
}

/**
 * Scenario C — recovery. A sharp drop at the price objection, then recovery once the dealer
 * offers a pilot. Its opening follows the live demo script exactly (SPEC.md §10).
 */
export const RECOVERY: DemoScript = {
  name: 'demo-recovery',
  title: 'Harbor & Main Retail — recovery',
  description: 'A price objection drops the estimate; a pilot offer brings it back.',
  turns: [
    { speaker: 'dealer', text: "Hi Sam, thanks for taking the call. I'd like to show you how we help store managers plan staffing." },
    { speaker: 'customer', text: "Sure. We've been struggling with scheduling across our stores, so I'm interested." },
    { speaker: 'customer', text: "I checked the pricing page, though. That's more than we expected for a team our size." },
    { speaker: 'dealer', text: "That's a fair point. What if we started with a three-month pilot on your two busiest stores, with onboarding included?" },
    { speaker: 'customer', text: 'A pilot on two stores could work. How soon could we start?' },
    { speaker: 'dealer', text: 'We could start next month, and annual pricing brings the per-store cost down after the pilot.' },
    { speaker: 'customer', text: "That helps. I'll need to run it by finance before we commit." },
    { speaker: 'dealer', text: "Of course. I'll send over a pilot proposal today so you have it for that conversation." },
  ],
}

export const DEMO_SCRIPTS: readonly DemoScript[] = [SUCCESSFUL_CLOSE, LOST_DEAL, RECOVERY]

/**
 * Lines the mock backend returns as "transcripts" when a push-to-talk control is released,
 * taken in order per speaker. Following the live demo — Dealer, Customer, Customer, Dealer —
 * reproduces the opening of the recovery scenario.
 */
export const LIVE_DEMO_SCRIPT: DemoScript = RECOVERY
