import { useId } from 'react'

import { AuthIdentityInputCountrySelect } from './AuthIdentityInputCountrySelect'
import { AuthIdentityInputField } from './AuthIdentityInputField'
import { AuthIdentityInputIcon } from './AuthIdentityInputIcon'
import { AuthIdentityInputLabel } from './AuthIdentityInputLabel'
import { useAuthIdentityInput } from './useAuthIdentityInput'

import type { PhoneInputResponseType } from 'react-simple-phone-input'

export type AuthIdentityInputLabels = {
  email: string
  neutral: string
  phone: string
}

function IdentityError({ error, testId }: { error?: string; testId: string }) {
  return error ? (
    <p className="mt-2 text-xs text-red-400" data-testid={`${testId}-error`}>
      {error}
    </p>
  ) : null
}

type AuthIdentityInputProps = {
  autoFocus?: boolean
  // ISO-3166 alpha-2 code the country selector should display (e.g. "GB").
  // Controlled on purpose: the selector holds its own `selected` state, so a
  // caller that keeps the dial code across a remount MUST also feed the
  // country back in, or the flag re-mounts at the default while the caller
  // still holds the old dial code — a "+44 held, 🇺🇸 shown" mismatch that
  // silently prefixes the wrong country onto the next number typed. The
  // library re-derives its selection whenever this prop changes, so this
  // also restores the ability to pick back to the country already displayed.
  country?: string
  disabled?: boolean
  // Autocomplete hint for the email/neutral case only — phone always
  // autocompletes as "tel". Defaults to "username" (the token that opts a
  // field into saved-credential autofill). Pass "email" on a sign-up screen,
  // where the address genuinely is new — see useAuthIdentityInput.
  emailAutoComplete?: 'email' | 'username'
  error?: string
  isPrototype?: boolean,
  labels: AuthIdentityInputLabels,
  name: string,
  onChange: (value: string) => void,
  // Fires with the country selector's currently chosen dial code (e.g.
// "+44") whenever it changes — pass through to normalizeSubmitPhone at
// submit time. Omit if the caller never submits a phone number. The second
// argument is the matching ISO-3166 alpha-2 code, for callers that persist
// the selection and feed it back via `country` (see above); callers that
// only need the dial code can ignore it.
  onDialCodeChange?: (dialCode: string, countryCode: string) => void,
  placeholders: AuthIdentityInputLabels,
  // Fixes the value: the field still reads at full contrast and stays
  // focusable/copyable, unlike `disabled`. Used where the identity was
  // supplied for the user rather than typed by them (the invite terms gate,
  // whose address comes out of the invite token).
  readOnly?: boolean
  testId: string
  value: string
}

// The single autodetecting phone-or-email field (Asana 1216644628063242)
// that replaces two separate fields joined by an "OR" divider. One real
// <input> (AuthIdentityInputField) stays mounted for the field's whole
// lifetime — only the decorative AuthIdentityInputLabel/Icon crossfade as
// `useAuthIdentityInput` resolves the typed value between phone and email —
// so focus and caret position are never lost mid-keystroke, and only the
// surrounding chrome performs the "smooth transition" the ticket asks for.
/* eslint max-lines-per-function: ['error', { max: 65, skipBlankLines: true, skipComments: true }] */
export const AuthIdentityInput = ({
  autoFocus,
  country = 'US',
  disabled,
  emailAutoComplete,
  error,
  labels,
  name,
  onChange,
  onDialCodeChange,
  placeholders,
  isPrototype = false,
  readOnly,
  testId,
  value,
}: AuthIdentityInputProps) => {
  const inputId = useId()
  const { autoComplete, inputMode, kind } = useAuthIdentityInput(value, {
    emailAutoComplete,
  })
  const isPhone = kind === 'phone'

  // The library's dialCode already carries a leading "+" (e.g. "+44"), and
  // its `code` is the alpha-2 the `country` prop above round-trips on.
  const handleCountryChange = (data: PhoneInputResponseType) =>
    onDialCodeChange?.(data.dialCode, data.code)

  return (
    <div data-identity-kind={kind} data-testid={testId}>
      <label className="block text-sm font-medium text-white" htmlFor={inputId}>
        <AuthIdentityInputLabel kind={kind} text={labels[kind]} />
      </label>
      <div className="mt-2 relative">
        {isPhone && onDialCodeChange ? (
          <AuthIdentityInputCountrySelect
            country={country}
            onChange={handleCountryChange}
            testId={`${testId}-country-select`}
          />
        ) : (
          !isPrototype && <AuthIdentityInputIcon />
        )}
        <AuthIdentityInputField
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          error={error}
          id={inputId}
          inputMode={inputMode}
          isPrototype={isPrototype}
          name={name}
          onChange={onChange}
          placeholder={placeholders[kind]}
          readOnly={readOnly}
          testId={testId}
          value={value}
          wide={isPhone && !!onDialCodeChange}
        />
      </div>
      <IdentityError error={error} testId={testId} />
    </div>
  )
}

AuthIdentityInput.displayName = 'AuthIdentityInput'
