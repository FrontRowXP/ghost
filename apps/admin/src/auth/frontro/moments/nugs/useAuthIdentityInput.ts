import { detectIdentityKind } from './identityDetection'

import type { IdentityKind } from './identityDetection'

export type IdentityInputKind = IdentityKind | 'neutral'

type UseAuthIdentityInputOptions = {
  // Hint for the email/neutral case only — phone always autocompletes as
  // 'tel'. Defaults to 'username' (the token that opts a field into
  // saved-credential autofill; 'email' marks it as contact information
  // instead, which makes iOS offer "Hide My Email" and never the saved
  // password — see Asana/PR #8096). Callers on a sign-up flow, where the
  // address genuinely is new, should pass 'email' instead.
  emailAutoComplete?: 'email' | 'username'
}

type UseAuthIdentityInputResult = {
  autoComplete: string
  inputMode: 'email' | 'tel' | 'text'
  kind: IdentityInputKind
}

// Derives the presentation state (which icon/label to show, and which mobile
// keyboard/autocomplete hint to request) from the raw typed value. `kind` is
// 'neutral' only before anything has been typed — once the field has content
// it is always resolved to 'phone' or 'email' via detectIdentityKind.
export const useAuthIdentityInput = (
  value: string,
  { emailAutoComplete = 'username' }: UseAuthIdentityInputOptions = {},
): UseAuthIdentityInputResult => {
  const kind: IdentityInputKind = value.trim()
    ? detectIdentityKind(value)
    : 'neutral'
  const inputMode =
    kind === 'phone' ? 'tel' : kind === 'email' ? 'email' : 'text'
  const autoComplete = kind === 'phone' ? 'tel' : emailAutoComplete
  return { autoComplete, inputMode, kind }
}
