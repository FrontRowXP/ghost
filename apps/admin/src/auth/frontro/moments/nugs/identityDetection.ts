export type IdentityKind = 'email' | 'phone'

// Autodetects whether free-typed text is more likely a phone number or an
// email address, so a single input can replace separate phone/email fields
// (Asana 1216644628063242). This is a documented judgment call rather than
// an exact science — ambiguous input is inherently ambiguous:
//   - An "@" anywhere in the value is decisive and wins over everything
//     else: always email, regardless of what precedes it. This means a
//     value like "3dprinter@gmail.com" resolves to phone mode transiently
//     while only "3dprinter" has been typed (a leading digit), then flips to
//     email mode the instant "@" appears — the transition is intentional
//     and covered by the smooth-transition UI, not a bug.
//   - Absent an "@", a leading digit, "+", or "(" reads as the start of a
//     phone number (phone numbers are the only identifier type that starts
//     with those characters).
//   - Anything else (a leading letter, or an empty value) defaults to
//     email, since email is the more common entry point and a leading
//     letter is virtually always the start of an email address.
export const detectIdentityKind = (rawValue: string): IdentityKind => {
  const value = rawValue.trim()
  if (value.includes('@')) return 'email'
  if (/^[+\d(]/.test(value)) return 'phone'
  return 'email'
}
