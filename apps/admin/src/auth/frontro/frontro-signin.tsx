import { useCallback, useEffect, useRef, useState } from 'react';
import { useCompleteFrontroAuth, useStartFrontroAuth } from '@tryghost/admin-x-framework/api/authentication';
import { useBrowseSite } from '@tryghost/admin-x-framework/api/site';
import { AuthModal } from './moments/AuthModal';
import { AuthError, authMessage, authRequest, type Session } from './moments/client';
import { reloadAdmin } from '../reload';
import { takeSigninRedirect } from '../signin-redirect';
import './moments/auth.css';

export default function FrontroSignin({ apiOrigin }: { apiOrigin: string }) {
  const { data: site } = useBrowseSite();
  const start = useStartFrontroAuth();
  const complete = useCompleteFrontroAuth();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const connecting = useRef(false);
  const active = useRef(true);
  // Keep the decision across StrictMode's effect replay: consuming storage in
  // the first effect must not let the second effect immediately sign in again.
  const skipAutoConnect = useRef(Boolean(sessionStorage.getItem('frontro-explicit-signout')));

  const connect = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true;
    try {
      const identity = await authRequest<Session>('/me', undefined, undefined, 20000, undefined, apiOrigin);
      const handoff = await start.mutateAsync(undefined);
      await authRequest('/auth/handoffs/' + encodeURIComponent(handoff.id) + '/approve',
        { code: handoff.code }, identity.user.csrfToken, 20000, undefined, apiOrigin);
      const result = await complete.mutateAsync(undefined);
      if (!result.authenticated) throw new AuthError('frontro_auth_unavailable', 503);
      if (active.current) reloadAdmin(takeSigninRedirect());
    } catch (cause) {
      const details = cause && typeof cause === 'object'
        ? cause as { response?: Response; data?: { errors?: Array<{ message?: string }> } } : null;
      const code = details?.data?.errors?.[0]?.message;
      const status = details?.response?.status || 503;
      throw code ? new AuthError(status === 429 ? 'rate_limited' : code, status,
        Number(details?.response?.headers.get('Retry-After')) || 0) : cause;
    } finally {
      connecting.current = false;
    }
  }, [apiOrigin, start.mutateAsync, complete.mutateAsync]);

  useEffect(() => {
    active.current = true;
    if (!site) return () => {active.current = false;};
    if (site?.site.frontroAuth?.siteSignInUrl) {
      location.assign(site.site.frontroAuth.siteSignInUrl);
      return () => { active.current = false; };
    }
    if (skipAutoConnect.current) {
      sessionStorage.removeItem('frontro-explicit-signout');
      setChecking(false);
      return () => { active.current = false; };
    }
    // Existing Moments sessions provide SSO. An ordinary anonymous session
    // renders the very same modal instead of starting another password flow.
    void authRequest<Session>('/me', undefined, undefined, 20000, undefined, apiOrigin)
      .then(async () => { if (active.current) await connect(); })
      .catch(cause => {
        if (active.current && !(cause instanceof AuthError && cause.status === 401)) {
          setError(authMessage(cause));
        }
      })
      .finally(() => { if (active.current) setChecking(false); });
    return () => { active.current = false; };
  }, [apiOrigin, connect, Boolean(site), site?.site.frontroAuth?.siteSignInUrl]);

  if (checking) return <main className="auth-screen auth-surface"><p role="status">Opening Gather…</p></main>;
  return <>
    <AuthModal apiOrigin={apiOrigin} onAuthenticated={connect} onClose={() => location.assign('/')} />
    {site?.site.gatherSites && <a className="frontro-sites-entry" href="#/sites">Manage your sites or create an account</a>}
    {error && <div className="frontro-connection-error" role="alert">{error}</div>}
  </>;
}
