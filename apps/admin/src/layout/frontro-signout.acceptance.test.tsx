import { beforeEach, expect, it, vi } from 'vitest';
import { siteResponse } from '@tryghost/test-data';
import { fakeAdminEndpoint, fakeEndpoint, fakeSetupStatus, renderAdminApp } from '@test-utils/acceptance';
import { reloadAdmin } from '@/auth/reload';
import { sidebarScreen } from './sidebar.screen';

vi.mock('@/auth/reload', () => ({ reloadAdmin: vi.fn() }));
const apiOrigin = 'https://moments.frontro.com';
const boot = () => ({ boot: { browseSite: { response: { site: {
  ...siteResponse().site, authReact: true, frontroAuth: { apiOrigin },
} } } } });

beforeEach(() => {
  vi.mocked(reloadAdmin).mockClear();
  sessionStorage.clear();
  fakeSetupStatus();
});

it('routes the sidebar through shared sign-out instead of immediately reconnecting', async () => {
  const ghostLogout = fakeAdminEndpoint('DELETE', '/session/', {});
  await renderAdminApp('/site', boot());
  await sidebarScreen.userMenuTrigger().click();
  await sidebarScreen.signOutMenuItem().click();
  await expect.poll(() => vi.mocked(reloadAdmin).mock.calls).toEqual([['/signout']]);
  expect(ghostLogout.requests).toHaveLength(0);
});

it('shared sign-out revokes both sessions and marks the next sign-in as explicit', async () => {
  fakeEndpoint('GET', apiOrigin + '/v1/me', { user: { id: 'fixture', csrfToken: 'fixture-csrf' } });
  const momentsLogout = fakeEndpoint('POST', apiOrigin + '/v1/auth/logout', {});
  const ghostLogout = fakeAdminEndpoint('DELETE', '/session/', {});
  await renderAdminApp('/signout', boot());
  await expect.poll(() => vi.mocked(reloadAdmin).mock.calls).toEqual([['/signin']]);
  expect(momentsLogout.requests).toHaveLength(1);
  expect(ghostLogout.requests).toHaveLength(1);
  expect(sessionStorage.getItem('frontro-explicit-signout')).toBe('1');
});
