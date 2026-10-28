'use client'

import type { ComponentProps } from 'react'
import { useFormStatus } from 'react-dom'

type Props = ComponentProps<'button'> & { pendingLabel?: string }

/**
 * Submit button that reflects its parent <form>'s pending state.
 * Disables + swaps to `pendingLabel` (and sets aria-busy) while the server
 * action runs, so every mutating action gives immediate, accessible feedback
 * and can't be double-submitted. Must be rendered inside the <form> it submits.
 */
export default function SubmitButton({ children, pendingLabel, className = 'btn btn-primary', disabled, ...rest }: Props) {
  const { pending } = useFormStatus()
  return (
    <button
      {...rest}
      type="submit"
      className={className}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  )
}
