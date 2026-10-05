import { beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { siteResponse } from '@tryghost/test-data';
import { fakeAdminEndpoint, fakeEndpoint, fakeSetupStatus, renderAdminApp, signedOut } from '@test-utils/acceptance';
import { reloadAdmin } from '../reload';

vi.mock('../reload', () => ({ reloadAdmin: vi.fn() }));
const apiOrigin = 'https://api.moments.frontro.com';
const handoffId = '12345678-1234-1234-1234-123456789abc';
function boot() {
  const options = signedOut({ authReact: true });
  return { ...options, boot: { ...options.boot, browseSite: { response: {
    site: { ...siteResponse().site, authReact: true, frontroAuth: { apiOrigin } },
  } } } };
}
beforeEach(() => {
  vi.mocked(reloadAdmin).mockClear();
  sessionStorage.clear();
  fakeSetupStatus();
  fakeEndpoint('GET', apiOrigin + '/v1/auth/providers', {
    email: true, phone: true, social: ['google', 'facebook', 'linkedin', 'x'],
  });
});

it('uses the Moments modal for an anonymous Gather visitor', async () => {
  fakeEndpoint('GET', apiOrigin + '/v1/me', { code: 'authentication_required' }, { status: 401 });
  await renderAdminApp('/signin', boot());
  await expect.element(page.getByLabelText('Phone or Email')).toBeVisible();
  await expect.element(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect.element(page.getByLabelText('Password')).not.toBeInTheDocument();
});

it('exchanges an existing Moments session and resumes the requested admin route', async () => {
  sessionStorage.setItem('ghost-signin-redirect', '/posts');
  fakeEndpoint('GET', apiOrigin + '/v1/me', { user: { id: handoffId, csrfToken: 'fixture-csrf' } });
  fakeAdminEndpoint('POST', '/authentication/frontro/start/', { id: handoffId, code: 'ABCD1234' });
  const approval = fakeEndpoint('POST', apiOrigin + '/v1/auth/handoffs/' + handoffId + '/approve', {});
  fakeAdminEndpoint('POST', '/authentication/frontro/complete/', { authenticated: true });
  await renderAdminApp('/signin', boot());
  await expect.poll(() => vi.mocked(reloadAdmin).mock.calls).toEqual([['/posts']]);
  expect(approval.lastRequest?.body).toEqual({ code: 'ABCD1234' });
});

it('does not reconnect after explicit sign-out, including effect replay', async () => {
  sessionStorage.setItem('frontro-explicit-signout', '1');
  const me = fakeEndpoint('GET', apiOrigin + '/v1/me', { user: { id: handoffId, csrfToken: 'fixture-csrf' } });
  await renderAdminApp('/signin', boot());
  await expect.element(page.getByLabelText('Phone or Email')).toBeVisible();
  expect(me.requests).toHaveLength(0);
  expect(vi.mocked(reloadAdmin)).not.toHaveBeenCalled();
});

it('reports a staff access denial without treating it as sign-in success', async () => {
  fakeEndpoint('GET', apiOrigin + '/v1/me', { user: { id: handoffId, csrfToken: 'fixture-csrf' } });
  fakeAdminEndpoint('POST', '/authentication/frontro/start/', { id: handoffId, code: 'ABCD1234' });
  fakeEndpoint('POST', apiOrigin + '/v1/auth/handoffs/' + handoffId + '/approve', {});
  fakeAdminEndpoint('POST', '/authentication/frontro/complete/',
    { errors: [{ message: 'frontro_staff_access_required' }] }, { status: 403 });
  await renderAdminApp('/signin', boot());
  await expect.element(page.getByRole('alert')).toHaveTextContent(/does not have access/);
  expect(vi.mocked(reloadAdmin)).not.toHaveBeenCalled();
});
