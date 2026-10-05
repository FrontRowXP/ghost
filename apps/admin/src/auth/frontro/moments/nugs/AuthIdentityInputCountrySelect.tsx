import { useEffect, useRef } from 'react'

import { AnimatePresence, motion } from 'framer-motion'
import { PhoneInput as SimplePhoneInput } from 'react-simple-phone-input'

import type { PhoneInputResponseType } from 'react-simple-phone-input'

export type AuthIdentityInputCountrySelectProps = {
  country: string
  onChange: (data: PhoneInputResponseType) => void
  testId: string
}

// `disableInput` reduces react-simple-phone-input down to just its
// flag/dial-code dropdown button — no text field of its own — so it can sit
// as a compact prefix control next to AuthIdentityInputField's real <input>
// without a second, competing text field. Kept in its own file (unlike the
// Mail/Phone AuthIdentityInputIcon crossfade) because it owns interactive
// state (the open dropdown), not just decoration.
//
// containerClass MUST be overridden: the library's own default (a light
// gray bordered box, `border border-solid border-gray-200 rounded-lg`)
// otherwise renders behind/around just the flag button, visually competing
// with — and partially occluding — AuthIdentityInputField's real text
// (found via live preview screenshot, not visible from the source alone).
// containerClass only reaches the OUTERMOST wrapper div; the library nests
// two more hardcoded, unconfigurable div layers below it (the bordered
// pill, then a bg-gray-100/60 button-wrapper) that containerClass alone
// can't reach — hence the descendant selectors.
const CONTAINER_CLASS =
  'border-0 !bg-transparent [&_div]:!border-0 [&_div]:!bg-transparent'
const BUTTON_CLASS =
  'flex items-center gap-1 rounded-md border-0 !bg-transparent !p-0 text-white/90'
const DROPDOWN_CLASS =
  'absolute left-0 top-[calc(100%+0.5rem)] z-20 m-0 h-[220px] w-[240px] list-none overflow-y-auto rounded-lg border border-white/20 bg-black p-0 text-white shadow-[0_4px_15px_rgba(0,0,0,0.5)] [&.invisible]:h-0 [&.invisible]:overflow-hidden'
const DROPDOWN_ITEM_CLASS =
  'my-[3px] flex items-center gap-1.5 px-2 py-1 hover:bg-white/10 [&.active]:bg-white/10'

export const AuthIdentityInputCountrySelect = ({
  country,
  onChange,
  testId,
}: AuthIdentityInputCountrySelectProps) => {
  const wrapperRef = useRef<HTMLSpanElement>(null)

  // `disableInput` does NOT remove the library's own text <input> from the
  // DOM — it only adds the `disabled` attribute, and that input has no
  // border/background of its own in its className, so the browser's native
  // disabled-input styling (a solid white pill) rendered right over
  // AuthIdentityInputField's real text. A Tailwind arbitrary-variant
  // selector for this (nested attribute-selector brackets,
  // `[&_input[type="tel"]]:hidden`) did not compile in this project — a
  // direct DOM query sidesteps that CSS-pipeline gap entirely. Querying by
  // type="tel" (not a blanket `input` selector) so the dropdown's own
  // `input[type="text"]` search box is left untouched.
  useEffect(() => {
    const telInput =
      wrapperRef.current?.querySelector<HTMLInputElement>('input[type="tel"]')
    if (telInput) telInput.style.display = 'none'
  }, [])

  return (
    <AnimatePresence>
      <motion.span
        animate={{ opacity: 1, scale: 1 }}
        className="absolute left-2 top-1/2 z-10 -translate-y-1/2"
        data-testid={testId}
        exit={{ opacity: 0, scale: 0.7 }}
        initial={{ opacity: 0, scale: 0.7 }}
        ref={wrapperRef}
        transition={{ duration: 0.15 }}
      >
        <SimplePhoneInput
          buttonClass={BUTTON_CLASS}
          containerClass={CONTAINER_CLASS}
          country={country}
          disableInput
          dropdownClass={DROPDOWN_CLASS}
          dropdownListClass={DROPDOWN_ITEM_CLASS}
          onChange={onChange}
          placeholder=""
          showSearchIcon={false}
        />
      </motion.span>
    </AnimatePresence>
  )
}

AuthIdentityInputCountrySelect.displayName = 'AuthIdentityInputCountrySelect'
