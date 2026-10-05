import type { ComponentType } from 'react'

import {
  FaApple,
  FaDiscord,
  FaFacebookF,
  FaLinkedinIn,
  FaXTwitter,
} from 'react-icons/fa6'
import { FcGoogle } from 'react-icons/fc'

import type { SocialAuthOption } from './types'
import type { IconBaseProps } from 'react-icons/lib'

type ProviderStyle = {
  Icon: ComponentType<IconBaseProps>
  buttonClass: string
  iconClass: string
}

// Round icon-button styling per provider, matching the viewer's v2 SocialRow so
// the two apps present identical brand marks. Keyed by the app-agnostic
// SocialAuthOption rather than the GraphQL AuthProviderType enum.
export const PROVIDER_STYLES: Record<SocialAuthOption, ProviderStyle> = {
  apple: {
    Icon: FaApple,
    buttonClass: 'bg-white',
    iconClass: 'text-black',
  },
  discord: {
    Icon: FaDiscord,
    buttonClass: 'bg-[#5865F2]',
    iconClass: 'text-white',
  },
  facebook: {
    Icon: FaFacebookF,
    buttonClass: 'bg-[#1877F2]',
    iconClass: 'text-white',
  },
  google: {
    Icon: FcGoogle,
    buttonClass: 'bg-white/10',
    iconClass: '',
  },
  linkedin: {
    Icon: FaLinkedinIn,
    buttonClass: 'bg-[#0A66C2]',
    iconClass: 'text-white',
  },
  x: {
    Icon: FaXTwitter,
    buttonClass: 'bg-black',
    iconClass: 'text-white',
  },
}
