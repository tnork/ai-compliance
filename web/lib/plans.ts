export type Plan = {
  id: 'solo' | 'firm' | 'practice'
  name: string
  price: number
  seats: string
  blurb: string
  features: string[]
  featured?: boolean
}

export const PLANS: Plan[] = [
  { id: 'solo', name: 'Solo', price: 25, seats: '1 seat', blurb: 'One practitioner building a defensible AI habit.', features: ['AI policy generator', 'Review-record log', 'Defense packet export', 'Data-minimized by default'] },
  { id: 'firm', name: 'Firm', price: 60, seats: 'up to 10 seats', featured: true, blurb: 'Small tax practices needing staff acknowledgments + admin visibility.', features: ['Everything in Solo', 'Staff attestation tracking', 'Tool-vetting register', 'Coverage dashboard'] },
  { id: 'practice', name: 'Practice', price: 130, seats: 'up to 30 seats', blurb: 'Multi-office firms preparing for integrations + SSO.', features: ['Everything in Firm', 'Provider-log ingestion', 'SSO-ready posture', 'BAA & self-host options'] },
]
