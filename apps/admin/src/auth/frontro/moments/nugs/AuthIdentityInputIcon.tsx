import { User } from 'lucide-react'

// The field's leading icon: a single neutral person glyph. It previously
// crossfaded between Mail and Phone as the detected identity kind flipped,
// but this one field accepts either an email or a phone number, so a neutral
// user/identity glyph reads as "who are you" without prematurely committing
// the icon to one input type (Brandon's request). The label above the field
// still adapts to the detected kind — see AuthIdentityInputLabel.
export const AuthIdentityInputIcon = () => (
  <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2">
    <User className="h-4 w-4 text-white/90" />
  </span>
)

AuthIdentityInputIcon.displayName = 'AuthIdentityInputIcon'
