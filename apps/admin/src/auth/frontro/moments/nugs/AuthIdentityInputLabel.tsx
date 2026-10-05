import { AnimatePresence, motion } from 'framer-motion'

import type { IdentityInputKind } from './useAuthIdentityInput'

type AuthIdentityInputLabelProps = {
  kind: IdentityInputKind
  text: string
}

// The field's label text, crossfaded (mode="wait" avoids two labels ever
// stacking) as `kind` flips between phone/email/neutral.
export const AuthIdentityInputLabel = ({
  kind,
  text,
}: AuthIdentityInputLabelProps) => (
  <AnimatePresence mode="wait">
    <motion.span
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      initial={{ opacity: 0, y: -4 }}
      key={kind}
      transition={{ duration: 0.15 }}
    >
      {text}
    </motion.span>
  </AnimatePresence>
)

AuthIdentityInputLabel.displayName = 'AuthIdentityInputLabel'
