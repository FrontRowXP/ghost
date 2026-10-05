import type { ChangeEvent } from 'react'

import clsx from 'clsx'

type AuthIdentityInputFieldProps = {
  autoComplete: string
  autoFocus?: boolean
  disabled?: boolean
  error?: string
  id: string
  inputMode: 'email' | 'tel' | 'text'
  isPrototype?: boolean
  name: string
  onChange: (value: string) => void
  placeholder: string
  // Renders the value as fixed rather than editable. Distinct from `disabled`
  // on purpose: a read-only field keeps full-contrast text, stays focusable,
  // and stays selectable/copyable, which is what a prefilled identity the user
  // must READ and confirm needs. `disabled` greys the text out and drops the
  // field from the tab order, which reads as "broken" for a value that is
  // simply not the user's to change.
  readOnly?: boolean
  testId: string
  value: string
  // Extra left padding to clear the wider country-select button that
  // replaces the plain Mail/Phone icon when phone mode shows it. Applied as
  // an inline style, not a Tailwind class (e.g. `pl-28`) — confirmed via
  // live preview that this project's compiled CSS does not include that
  // utility (computed padding-left stayed 0px despite the class being
  // present in the DOM), while `pl-10` on the default path does. Inline
  // style sidesteps whatever purges/scans it, guaranteed to apply.
  wide?: boolean
}

// Clears the fixed-width country-select button (react-simple-phone-input pins
// its flag/dial-code area to w-24 = 6rem, sitting 0.5rem from the input's left
// edge, so its right edge lands at ~6.5rem regardless of dial-code length).
// 7rem leaves a snug ~0.5rem gap between the selector and the first digit —
// tightened from the previous 8rem, which left a visibly wide gap (Brandon).
const WIDE_PADDING_LEFT = '7rem'

// The actual <input> element — stays mounted for the field's whole lifetime
// (see AuthIdentityInput) so it never remounts as detection flips between
// phone/email. Styled to the creator app's canonical FrontroAuthInput spec.
export const AuthIdentityInputField = ({
  autoComplete,
  autoFocus,
  disabled,
  error,
  id,
  inputMode,
  isPrototype = false,
  name,
  onChange,
  placeholder,
  readOnly,
  testId,
  value,
  wide,
}: AuthIdentityInputFieldProps) => (
  <input
    autoComplete={autoComplete}
    autoFocus={autoFocus}
    className={clsx(
      'h-11 w-full rounded-md border pl-10 pr-4 text-white transition-colors duration-150 placeholder:text-white/50',
      'bg-black/20 border-white/20',
      'focus-visible:outline-none focus-visible:border-white/40',
      'autofill:bg-black/30 autofill:text-white autofill:shadow-[inset_0_0_0_62.5rem_rgba(0,0,0,0.3)]',
      error && 'border-red-500/50',
      isPrototype && '!h-12 !rounded-[11px] !text-sm !bg-[rgba(4,7,18,0.58)]',
    )}
    data-testid={`${testId}-input`}
    disabled={disabled}
    id={id}
    inputMode={inputMode}
    name={name}
    onChange={(event: ChangeEvent<HTMLInputElement>) =>
      onChange(event.target.value)
    }
    placeholder={placeholder}
    readOnly={readOnly}
    style={
      wide
        ? { paddingLeft: WIDE_PADDING_LEFT }
        : isPrototype
          ? { paddingLeft: 14 }
          : undefined
    }
    type="text"
    value={value}
  />
)

AuthIdentityInputField.displayName = 'AuthIdentityInputField'
