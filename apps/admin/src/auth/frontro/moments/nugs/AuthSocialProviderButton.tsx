import clsx from 'clsx'
import { FaGoogle } from 'react-icons/fa6'

import { PROVIDER_STYLES } from './providerStyles'

import type { SocialAuthOption, SocialAuthProvider } from './types'

const BUTTON_ICON_CLASS: Record<SocialAuthOption, string> = {
  apple: 'text-black',
  discord: 'text-[#5865F2]',
  facebook: 'text-[#1877F2]',
  google: '',
  linkedin: 'text-[#0A66C2]',
  x: 'text-black',
}

type AuthSocialProviderButtonProps = {
  disabled: boolean
  getProviderLabel?: (provider: SocialAuthProvider) => string
  layout: 'buttons' | 'icons'
  onClick: (option: SocialAuthOption) => void
  provider: SocialAuthProvider
  providerLabelPrefix?: string
  testId: string
  variant?: 'default' | 'prototype'
}

const getLabel = ({
  provider,
  getProviderLabel,
  providerLabelPrefix,
}: Pick<
  AuthSocialProviderButtonProps,
  'provider' | 'getProviderLabel' | 'providerLabelPrefix'
>) => {
  const name = provider.title || provider.option
  return getProviderLabel
    ? getProviderLabel(provider)
    : providerLabelPrefix
      ? `${providerLabelPrefix} ${name}`
      : name
}

const getIconClass = (
  isPrototype: boolean,
  layout: 'buttons' | 'icons',
  option: SocialAuthOption,
) =>
  isPrototype
    ? 'h-7 w-7 text-white'
    : clsx(
        'h-6 w-6',
        layout === 'buttons'
          ? BUTTON_ICON_CLASS[option]
          : PROVIDER_STYLES[option].iconClass,
      )

export const AuthSocialProviderButton = ({
  disabled,
  getProviderLabel,
  layout,
  onClick,
  provider,
  providerLabelPrefix,
  testId,
  variant = 'default',
}: AuthSocialProviderButtonProps) => {
  const { Icon: DefaultIcon, buttonClass } = PROVIDER_STYLES[provider.option]
  const isPrototype = variant === 'prototype' && layout === 'icons'
  const Icon =
    isPrototype && provider.option === 'google' ? FaGoogle : DefaultIcon
  const providerLabel = getLabel({
    getProviderLabel,
    provider,
    providerLabelPrefix,
  })

  return (
    <button
      aria-label={providerLabel}
      className={clsx(
        'flex items-center justify-center transition-all hover:-translate-y-0.5 hover:opacity-90 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50',
        isPrototype
          ? 'h-[60px] w-[60px] shrink-0 rounded-full border border-white/30 bg-[#080808] text-white'
          : 'h-12',
        layout === 'buttons'
          ? 'w-full gap-3 rounded-xl border border-white/15 bg-white px-4 text-sm font-semibold text-[#050E35] shadow-sm'
          : !isPrototype && `w-12 rounded-full ${buttonClass}`,
      )}
      data-testid={`${testId}-${provider.option}`}
      disabled={disabled || !provider.loginUrl}
      onClick={() => onClick(provider.option)}
      type="button"
    >
      <Icon className={getIconClass(isPrototype, layout, provider.option)} />
      {layout === 'buttons' ? <span>{providerLabel}</span> : null}
    </button>
  )
}

AuthSocialProviderButton.displayName = 'AuthSocialProviderButton'
