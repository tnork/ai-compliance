'use server'

import { redirect } from 'next/navigation'
import { getStripe } from '@/lib/stripe'
import { PLANS } from '@/lib/plans'

export async function startCheckout(formData: FormData) {
  const planId = String(formData.get('plan'))
  const plan = PLANS.find((p) => p.id === planId)
  if (!plan) redirect('/billing')

  const stripe = getStripe()
  if (!stripe) {
    // Checkout not live yet - record intent and route to onboarding, never charge.
    redirect('/billing?stub=' + plan.id)
  }

  // TODO(checkout): create a real Stripe Checkout Session here (prices, seats, annual toggle)
  // and redirect to it. Until then, fall through to the onboarding-request path.
  redirect('/billing?stub=' + plan.id)
}
