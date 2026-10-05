# Approved nugs auth UI

Source: FrontRowXP/nugs PR #9776, commit
`51f438a8cab65fa4654be76ff973f8c521e54dc9`.
The user confirmed `verification/auth-social-first/viewer.png` from that design.

The shared `AuthGlassCard`, `AuthSocialRow`, `AuthSocialProviderButton`, provider
styles/types, `AuthIdentityInput` and its field/label/icon/country-selector/hooks,
identity detection, and `frontro-logo.svg` are copied verbatim. Their original
paths are `feature-libs/shared-features/src/components/{component}/`, with the
logo under `feature-libs/viewer-features/src/shared/components/WelcomeAuth/v2/assets/`.

`AuthCardHeader` retains the prototype layout/classes, replaces channel/i18n
hooks with explicit props and a local Moments home link, and makes the title an
accessible h1. `../AuthModal.tsx` composes these components using the original
identity-step order, spacing, terms/age notice, and cross-link. REST challenge,
verification, provider availability and native handoff belong to Moments;
no nugs GraphQL, cookies, provider URLs or legacy auth hooks are imported.

Integration details:
- Inter is bundled locally. Native clients render this same shared web component.
- The nugs prototype branch is always selected; no production feature flag needed.
- React 18 uses compatible `react-simple-phone-input` 5.2.1 and its namespaced
  stylesheet. The adapter CSS handles closed-menu visibility and vertical placement;
  marketing shadow event handling preserves country selection.
- Marketing uses a shadow root to contain auth CSS and a native modal dialog for
  focus containment, Escape, backdrop and inert background. Font faces register
  at document scope. Scroll locking and focus restoration live in that adapter.
- Unconfigured providers stay visible but disabled. Delivery and OAuth completion
  are separate from UI verification; see `docs/LOCAL_AUTH.md`.
