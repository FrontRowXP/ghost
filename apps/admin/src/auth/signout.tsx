import { useEffect, useRef } from 'react';
import { useAuthClient } from './client/auth-client';
import { reloadAdmin } from './reload';
import { takeSigninRedirect } from './signin-redirect';
import { useBrowseSite } from '@tryghost/admin-x-framework/api/site';
import { authRequest, type Session } from './frontro/moments/client';

export default function Signout() {
  const authClient = useAuthClient();
  const started = useRef(false);
  const { data: siteData, isPending } = useBrowseSite({ defaultErrorHandler: false });

  useEffect(() => {
    // StrictMode mounts effects twice; one sign out is enough.
    if (started.current || isPending) {
      return;
    }
    started.current = true;

    const signOut = async () => {
      const apiOrigin = siteData?.site.frontroAuth?.apiOrigin;
      if (apiOrigin) {
        sessionStorage.setItem('frontro-explicit-signout', '1');
        try {
          const identity = await authRequest<Session>('/me', undefined, undefined, 8000, undefined, apiOrigin);
          await authRequest('/auth/logout', {}, identity.user.csrfToken, 8000, undefined, apiOrigin);
        } catch { /* Still sign out of Gather if Moments is offline. */ }
      }
      try {
        await authClient.signOut();
      } catch {
        // Already signed out, or unreachable: the reload shows which.
      }
      takeSigninRedirect();
      reloadAdmin('/signin');
    };
    void signOut();
  }, [authClient, isPending, siteData]);

  return null;
}
