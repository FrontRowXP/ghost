import clsx from 'clsx'

import { AuthSocialProviderButton } from './AuthSocialProviderButton'

import type { SocialAuthOption, SocialAuthProvider } from './types'

type AuthSocialRowProps = {
  disabled?: boolean
  dividerLabel: string
  getProviderLabel?: (provider: SocialAuthProvider) => string
  layout?: 'buttons' | 'icons'
  onProviderClick: (option: SocialAuthOption) => void
  providerLabelPrefix?: string
  providers: SocialAuthProvider[]
  testId?: string
  variant?: 'default' | 'prototype'
}

// Presentational-only "or continue with" divider + round provider buttons.
// Deliberately has no GraphQL, cookie, feature-flag, or i18n dependency: the
// caller resolves the providers (useSocialAuthProviders), supplies the already
// translated dividerLabel, and handles the redirect (redirectToSocialProvider).
// This keeps the row trivially reusable across apps and unit-testable in
// isolation.
export const AuthSocialRow = ({
  disabled = false,
  dividerLabel,
  getProviderLabel,
  layout = 'icons',
  onProviderClick,
  providerLabelPrefix,
  providers,
  testId = 'auth-social-row',
  variant = 'default',
}: AuthSocialRowProps) => {
  if (!providers.length) return null

  return (
    <div className="flex flex-col items-center gap-4" data-testid={testId}>
      <div
        className={clsx(
          'flex w-full items-center gap-3 text-xs text-white/50',
          variant === 'prototype' && 'order-last',
        )}
      >
        <span className="h-px flex-1 bg-white/10" />
        <span>{dividerLabel}</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <div
        className={clsx(
          layout === 'buttons' ? 'grid w-full grid-cols-1 gap-3' : 'flex gap-3',
          variant === 'prototype' && 'flex-wrap justify-center',
        )}
      >
        {providers.map((provider) => (
          <AuthSocialProviderButton
            disabled={disabled}
            getProviderLabel={getProviderLabel}
            key={provider.option}
            layout={layout}
            onClick={onProviderClick}
            provider={provider}
            providerLabelPrefix={providerLabelPrefix}
            testId={testId}
            variant={variant}
          />
        ))}
      </div>
    </div>
  )
}

AuthSocialRow.displayName = 'AuthSocialRow'
