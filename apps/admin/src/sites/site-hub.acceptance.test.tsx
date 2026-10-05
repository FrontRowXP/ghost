import { beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { siteResponse } from '@tryghost/test-data';
import {
  fakeAdminEndpoint,
  fakeEndpoint,
  fakeSetupStatus,
  renderAdminApp,
  signedOut,
} from '@test-utils/acceptance';

const apiOrigin = 'https://api.moments.frontro.com';
const workspace = '11111111-1111-4111-8111-111111111111';
function boot(enabled = true, creationEnabled = false) {
  const options = signedOut({ authReact: true });
  return {
    ...options,
    boot: {
      ...options.boot,
      browseSite: {
        response: {
          site: {
            ...siteResponse().site,
            authReact: true,
            ...(enabled ? { gatherSites: { apiOrigin, creationEnabled, version: 1 } } : {}),
          },
        },
      },
    },
  };
}
beforeEach(() => {
  sessionStorage.clear();
  fakeSetupStatus();
  fakeEndpoint('GET', apiOrigin + '/v1/auth/providers', {
    email: true,
    phone: true,
    social: ['google'],
  });
});

it('lets a workspace owner create a site and shows preparing status until the server verifies its domain', async () => {
  fakeAdminEndpoint('GET', '/gather/session/', {
    user: { id: workspace, name: 'Ben' },
    workspaces: [{ id: workspace, name: 'Frontro', role: 'owner' }],
    csrfToken: 'a'.repeat(64),
    creationEnabled: true,
  });
  const prepared = {
    id: workspace,
    name: 'New publication',
    hostname: 'new.gather.example.test',
    status: 'provisioning',
  };
  let sites: (typeof prepared)[] = [];
  fakeAdminEndpoint('GET', '/gather/sites/', () => ({ sites }));
  const create = fakeAdminEndpoint(
    'POST',
    '/gather/sites/',
    () => {
      sites = [prepared];
      return { site: prepared };
    },
    { status: 201 },
  );
  await renderAdminApp('/sites', boot(true, true));
  await page.getByLabelText('Site name').fill('New publication');
  await page.getByLabelText('Site address').fill('new');
  await page.getByRole('button', { name: 'Create site', exact: true }).click();
  await expect.element(page.getByText('Preparing your site')).toBeVisible();
  expect(create.lastRequest?.body).toEqual({
    workspaceId: workspace,
    name: 'New publication',
    slug: 'new',
  });
  expect(create.requests).toHaveLength(1);
  await expect.element(page.getByRole('link', { name: 'Edit site' })).not.toBeInTheDocument();
});

it('shows a site-address conflict without retrying the creation write', async () => {
  fakeAdminEndpoint('GET', '/gather/session/', {
    user: { id: workspace, name: 'Ben' },
    workspaces: [{ id: workspace, name: 'Frontro', role: 'owner' }],
    csrfToken: 'a'.repeat(64),
    creationEnabled: true,
  });
  fakeAdminEndpoint('GET', '/gather/sites/', { sites: [] });
  const create = fakeAdminEndpoint(
    'POST',
    '/gather/sites/',
    { code: 'site_address_in_use' },
    { status: 409 },
  );
  await renderAdminApp('/sites', boot(true, true));
  await page.getByLabelText('Site name').fill('Publication');
  await page.getByLabelText('Site address').fill('taken');
  await page.getByRole('button', { name: 'Create site', exact: true }).click();
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('This site address is already in use. Choose another address.');
  expect(create.requests).toHaveLength(1);
  await expect.element(page.getByLabelText('Site address')).toHaveValue('taken');
});
it('handles an older backend without starting a signup or provisioning request', async () => {
  await renderAdminApp('/sites', boot(false));
  await expect
    .element(page.getByText('Site management is not available on this server yet.'))
    .toBeVisible();
  await expect.element(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
});
it('opens the shared Moments signup modal without a publication staff account', async () => {
  fakeAdminEndpoint(
    'GET',
    '/gather/session/',
    { code: 'authentication_required' },
    { status: 401 },
  );
  fakeEndpoint('GET', apiOrigin + '/v1/me', { code: 'authentication_required' }, { status: 401 });
  await renderAdminApp('/sites', boot());
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect.element(page.getByLabelText('Phone or Email')).toBeVisible();
  await expect.element(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect.element(page.getByLabelText('Password')).not.toBeInTheDocument();
});
it('shows only server-authorized sites and keeps creation disabled before isolation readiness', async () => {
  fakeAdminEndpoint('GET', '/gather/session/', {
    user: { id: workspace, name: 'Ben' },
    workspaces: [{ id: workspace, name: 'Frontro', role: 'owner' }],
    csrfToken: 'a'.repeat(64),
    creationEnabled: false,
  });
  fakeAdminEndpoint('GET', '/gather/sites/', {
    sites: [
      {
        id: workspace,
        name: 'Gather',
        hostname: 'gather.example.test',
        status: 'active',
        verified_at: '2026-10-05',
      },
    ],
  });
  const create = fakeAdminEndpoint('POST', '/gather/sites/', {});
  await renderAdminApp('/sites', boot());
  await expect
    .element(page.getByRole('link', { name: 'Edit site' }))
    .toHaveAttribute('href', 'https://gather.example.test/ghost/');
  await expect
    .element(page.getByRole('button', { name: 'Create site', exact: true }))
    .toBeDisabled();
  expect(create.requests).toHaveLength(0);
});
