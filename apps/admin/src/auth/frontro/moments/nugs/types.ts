// Shared social-auth (SSO) types used by AuthSocialRow, useSocialAuthProviders,
// and redirectToSocialProvider. These mirror the viewer's WelcomeAuth SSO
// mechanism but are app-agnostic so both the viewer and creator apps can drive
// the same OAuth flow (per-channel providers → backend LoginURL redirect).

// Social providers supported across channel configurations. String literals (not the
// generated AuthProviderType enum) so the presentational row and its tests
// never depend on the GraphQL codegen output.
export type SocialAuthOption =
  | 'apple'
  | 'discord'
  | 'facebook'
  | 'google'
  | 'linkedin'
  | 'x'

// Matches @nugs/cookies setSocialAuthTypeCookie's formType, which the backend
// reads on the OAuth return to decide sign-in vs. sign-up semantics.
export type SocialAuthFormType = 'LogIn' | 'SignUp'

// A provider resolved and flag-filtered from useGetChannelAuthProviders, mapped
// into the app-agnostic shape the row + redirect helper consume.
export type SocialAuthProvider = {
  imageUrl: string | null
  loginUrl: string
  option: SocialAuthOption
  title: string
}
