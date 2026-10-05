# Frontro / Moments staff sign-in

The `moments/` directory reuses the Moments auth modal and its Nugs-derived
components from `FrontRowXP/moments` at
`1c48cd6fd7022056412d9f8ec591dcbe6f5d47b5`. Keep their markup and interactions
aligned with that source. Gather supplies the API origin, its own OAuth return
route, public-site links, and the existing Admin Inter font. Its CSS uses Admin's
single Tailwind lane; it does not import a second Tailwind or Shade stylesheet.

The browser signs in directly against the **same Moments API**, with its normal
HttpOnly cookie, email/phone challenges, and enabled social providers. Core uses
the existing Moments `/v1/auth/handoffs` API to obtain a separate, server-held
session for the authenticated account. The handoff secret and cookie never enter
the browser payload. Core resolves the returned immutable account ID against an
operator-managed staff map and rotates Ghost's session using its existing SSO
session service. It never grants a role or creates staff from an email address.

Core advertises `site.frontroAuth` only when configured. That is the capability
check; older backends keep their existing password screen. The current Moments
API must explicitly allow the Gather HTTPS origin in `MOMENTS_ALLOWED_ORIGINS`
for credentialed requests, OAuth returns, and handoff operations.

Example private Ghost configuration (IDs are placeholders):

```json
{
  "security": {
    "frontroAuth": {
      "enabled": true,
      "apiOrigin": "https://api.moments.frontro.com",
      "staff": {
        "<verified-Moments-user-UUID>": "<existing-active-Ghost-staff-ID>"
      }
    }
  }
}
```

Do not publish this mapping in site responses or logs. First identify the account
through an authenticated Moments session; then link it to the intended existing
Ghost staff account. Test staging before enabling production. Unmapped users and
inactive staff are denied. Removing the mapping or disabling the provider denies
existing delegated sessions. Every protected session request rechecks Moments;
an outage denies access without treating it as a successful login or silently
falling back to a password. Normal Ghost role checks still determine permissions.

Ghost sign-out revokes its delegated API session. The React sign-out screen also
signs out the browser's Moments API session and prevents immediate SSO
reconnection after an explicit sign-out. Other independently issued device
sessions retain the Moments API's existing logout behavior.

The legacy Ghost password endpoint remains available for operator recovery;
changing that policy is separate from selecting the new public login screen.
Disabling `security.frontroAuth.enabled` restores the old screen. Themes and
publication icon/logo settings are separate from staff authentication.

## Validation

- `node --experimental-strip-types --test ghost/core/scripts/frontro-auth.test.cjs ghost/core/scripts/frontro-auth-client.test.cjs` checks the handoff,
  identity/role boundary, CSRF, expiry, replay, revocation, and provider failures.
- The Gather CI workflow builds both Core and Admin with the frozen workspace.
- Run the Admin auth acceptance specs, including the older-backend case, and the
  Core `frontro-auth.test.js` e2e API spec in the routed environment.
- Qualify real email/phone and social sign-in, remembered admin destinations,
  existing-session SSO, sign-out, and denied accounts on staging. Unit tests and
  a mocked local modal preview do not certify these live paths.

The server-side handoff calls currently share Moments' existing per-source-IP
rate limits. Configure and qualify the trusted proxy path or a scoped broker
rate-limit policy before scaling staff sign-in; do not forward untrusted client
IP headers or disable rate limiting.
