import type { FocusEventHandler, ReactNode } from 'react'

import clsx from 'clsx'
import { motion } from 'framer-motion'

type AuthGlassCardProps = {
  children: ReactNode
  className?: string
  onFocusCapture?: FocusEventHandler<HTMLDivElement>
  testId?: string
  variant?: 'default' | 'prototype'
}

// The canonical dark glassmorphic auth card: shared, verbatim, between the
// creator app's full-page login (FrontroAuthContainer) and the viewer app's
// modal (WelcomeAuth v2's GlassCard). Creator's visual spec is the source of
// truth here (rounded-3xl, border-white/12, p-8 md:p-10, shadow-2xl, and the
// scale/translateY/opacity entrance transition) — each app supplies its own
// outer positioning (full-screen video backdrop vs. dialog portal/backdrop)
// and may layer additional responsive classes via `className` (e.g. the
// viewer dialog's mobile full-bleed treatment).
export const AuthGlassCard = ({
  children,
  className,
  onFocusCapture,
  testId,
  variant = 'default',
}: AuthGlassCardProps) => {
  return (
    <motion.div
      animate={{ opacity: 1, scale: 1, y: 0 }}
      className={clsx(
        '[--error:theme(colors.red.400)]',
        variant === 'prototype'
          ? 'border border-white/15 rounded-[26px] p-8 max-[420px]:px-[18px] max-[420px]:py-6 max-[420px]:rounded-[20px] backdrop-blur-xl bg-[linear-gradient(145deg,rgba(13,18,35,0.92),rgba(5,8,20,0.78))] shadow-[0_32px_90px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.06)]'
          : 'bg-black/45 backdrop-blur-xl border border-white/12 rounded-3xl p-8 md:p-10 shadow-2xl',
        className,
      )}
      data-testid={testId}
      initial={{ opacity: 0, scale: 0.95, y: 20 }}
      onFocusCapture={onFocusCapture}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}

AuthGlassCard.displayName = 'AuthGlassCard'
