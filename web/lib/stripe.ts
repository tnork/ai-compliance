import Stripe from 'stripe'
import 'server-only'

// Lazily construct a Stripe client only when a key is configured. Until then, billing
// is stubbed (Phase 2: tiers defined, not charging). Real checkout lands in Phase 6.
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  return key ? new Stripe(key) : null
}
