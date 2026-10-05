import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowseSite } from '@tryghost/admin-x-framework/api/site';
import {
  gatherSitesRequest as request,
  SiteManagementError,
} from '@tryghost/admin-x-framework/api/gather-sites';
import { Button, Input, Label } from '@tryghost/shade/components';
import { PageHeader } from '@tryghost/shade/patterns';
import { AuthModal } from '@/auth/frontro/moments/AuthModal';
import { AuthError, authMessage, authRequest, type Session } from '@/auth/frontro/moments/client';
import logo from '@/auth/frontro/moments/nugs/frontro-logo.svg';
import '@/auth/frontro/moments/auth.css';
import './site-hub.css';

type Workspace = { id: string; name: string; role: string };
type HubSession = {
  user: { id: string; name: string };
  workspaces: Workspace[];
  csrfToken: string;
  creationEnabled: boolean;
};
type Site = { id: string; name: string; status: string; hostname?: string; verified_at?: string };
function message(cause: unknown) {
  if (cause instanceof SiteManagementError && cause.code === 'site_creation_unavailable') {
    return 'New sites are not available yet. You can continue editing your existing sites.';
  }
  if (cause instanceof SiteManagementError && cause.code === 'workspace_owner_required') {
    return 'Only a workspace owner can create a site.';
  }
  if (cause instanceof SiteManagementError) {
    return authMessage(new AuthError(cause.code, cause.status));
  }
  return authMessage(cause);
}

export default function SiteHub() {
  const { data, isLoading } = useBrowseSite();
  const capability = data?.site.gatherSites;
  if (isLoading) {
    return (
      <main className="gather-sites">
        <p role="status">Opening your sites…</p>
      </main>
    );
  }
  if (!capability) {
    return (
      <main className="gather-sites">
        <img alt="Frontro" className="gather-sites-logo" src={logo} />
        <h1>Your sites</h1>
        <p>Site management is not available on this server yet.</p>
        <a href="#/signin">Back to sign in</a>
      </main>
    );
  }
  return (
    <SitesWorkspace apiOrigin={capability.apiOrigin} creationEnabled={capability.creationEnabled} />
  );
}

function SitesWorkspace({
  apiOrigin,
  creationEnabled,
}: {
  apiOrigin: string;
  creationEnabled: boolean;
}) {
  const [session, setSession] = useState<HubSession | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<'login' | 'signup' | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const connecting = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const identity = await request<HubSession>('session/');
    const result = await request<{ sites: Site[] }>('sites/');
    if (mounted.current) {
      setSession(identity);
      setSites(result.sites);
      setWorkspace(identity.workspaces.find((item) => item.role === 'owner')?.id || '');
      setMode(null);
      setError('');
    }
  }, []);
  const connect = useCallback(async () => {
    if (connecting.current) {
      return;
    }
    connecting.current = true;
    try {
      const identity = await authRequest<Session>(
        '/me',
        undefined,
        undefined,
        20000,
        undefined,
        apiOrigin,
      );
      const handoff = await request<{ id: string; code: string }>('auth/start/', {});
      await authRequest(
        '/auth/handoffs/' + encodeURIComponent(handoff.id) + '/approve',
        { code: handoff.code },
        identity.user.csrfToken,
        20000,
        undefined,
        apiOrigin,
      );
      await request('auth/complete/', {});
      await load();
    } finally {
      connecting.current = false;
    }
  }, [apiOrigin, load]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void load()
      .catch(async (cause) => {
        if (
          (cause instanceof AuthError || cause instanceof SiteManagementError) &&
          cause.status === 401
        ) {
          if (!sessionStorage.getItem('frontro-explicit-signout')) {
            try {
              await connect();
            } catch (connectError) {
              if (active && !(connectError instanceof AuthError && connectError.status === 401)) {
                setError(message(connectError));
              }
            }
          }
        } else if (active) {
          setError(message(cause));
        }
      })
      .finally(() => {
        if (active) {
          setChecking(false);
        }
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [load, connect]);

  async function signout() {
    if (!session) {
      return;
    }
    try {
      await request('session/', undefined, session.csrfToken, 'DELETE');
      // The same API and explicit-signout intent as publication Admin.
      const identity = await authRequest<Session>(
        '/me',
        undefined,
        undefined,
        20000,
        undefined,
        apiOrigin,
      );
      await authRequest('/auth/logout', {}, identity.user.csrfToken, 20000, undefined, apiOrigin);
    } catch (cause) {
      setError(message(cause));
    } finally {
      sessionStorage.setItem('frontro-explicit-signout', '1');
      setSession(null);
      setSites([]);
      setMode(null);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!session?.creationEnabled || creating) {
      return;
    }
    setCreating(true);
    setError('');
    try {
      await request('sites/', { workspaceId: workspace, name, slug }, session.csrfToken);
      await load();
      setName('');
      setSlug('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setCreating(false);
    }
  }
  if (mode && !session) {
    return (
      <AuthModal
        apiOrigin={apiOrigin}
        initialMode={mode}
        oauthReturnTo={new URL('sites/', location.origin + location.pathname).href}
        onAuthenticated={connect}
        onClose={() => setMode(null)}
      />
    );
  }

  return (
    <main className="gather-sites">
      <img alt="Frontro" className="gather-sites-logo" src={logo} />
      {session ? (
        <PageHeader blurredBackground={false} sticky={false}>
          <PageHeader.Left>
            <PageHeader.Title>Your sites</PageHeader.Title>
          </PageHeader.Left>
          <PageHeader.Actions>
            <PageHeader.ActionGroup>
              <PageHeader.Action label="Sign out" onClick={() => void signout()}>
                Sign out
              </PageHeader.Action>
            </PageHeader.ActionGroup>
          </PageHeader.Actions>
        </PageHeader>
      ) : (
        <h1>{creationEnabled ? 'Create your home for stories' : 'Your Frontro sites'}</h1>
      )}
      <p>
        {session
          ? `Manage the sites in your Frontro workspaces, ${session.user.name || 'with your account'}.`
          : 'Publish with Frontro. Use the same account you use for Moments.'}
      </p>
      {!session && !creationEnabled && (
        <p role="status">New sites are not available yet. Sign in to manage your existing sites.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {checking ? (
        <p role="status">Opening your sites…</p>
      ) : !session ? (
        <div className="gather-sites-actions">
          <Button
            onClick={() => {
              sessionStorage.removeItem('frontro-explicit-signout');
              setMode('signup');
            }}
          >
            Create an account
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              sessionStorage.removeItem('frontro-explicit-signout');
              setMode('login');
            }}
          >
            Sign in
          </Button>
          <a href="#/signin">Open this publication</a>
        </div>
      ) : (
        <>
          <section aria-label="Your existing sites" className="gather-sites-list">
            {sites.length ? (
              sites.map((site) => (
                <article key={site.id} className="gather-site-card">
                  <h2>{site.name}</h2>
                  <p>{site.hostname || 'Your domain is being prepared'}</p>
                  {site.status === 'active' && site.verified_at && site.hostname ? (
                    <a href={`https://${site.hostname}/ghost/`}>Edit site</a>
                  ) : (
                    <span role="status">Preparing your site</span>
                  )}
                </article>
              ))
            ) : (
              <p>You do not have access to any sites yet.</p>
            )}
          </section>
          <section className="gather-site-card">
            <h2>Create a site</h2>
            {!session.creationEnabled && (
              <p role="status">
                New sites are not available yet. You can continue editing your existing sites.
              </p>
            )}
            <form
              className="gather-site-form"
              onSubmit={(event) => {
                void create(event);
              }}
            >
              <Label htmlFor="site-workspace">Workspace</Label>
              <select
                id="site-workspace"
                value={workspace}
                required
                onChange={(event) => setWorkspace(event.target.value)}
              >
                <option value="">Select a workspace</option>
                {session.workspaces
                  .filter((item) => item.role === 'owner')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
              <Label htmlFor="site-name">Site name</Label>
              <Input
                id="site-name"
                maxLength={191}
                placeholder="My publication"
                value={name}
                required
                onChange={(event) => setName(event.target.value)}
              />
              <Label htmlFor="site-slug">Site address</Label>
              <Input
                id="site-slug"
                maxLength={63}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="my-publication"
                value={slug}
                required
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
              />
              <Button disabled={!session.creationEnabled || !workspace || creating} type="submit">
                {creating ? 'Creating your site…' : 'Create site'}
              </Button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
