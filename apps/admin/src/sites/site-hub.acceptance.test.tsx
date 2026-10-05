import {beforeEach, expect, it} from 'vitest';
import {page} from 'vitest/browser';
import {siteResponse} from '@tryghost/test-data';
import {fakeAdminEndpoint, fakeEndpoint, fakeSetupStatus, renderAdminApp, signedOut} from '@test-utils/acceptance';

const apiOrigin = 'https://api.moments.frontro.com';
const workspace = '11111111-1111-4111-8111-111111111111';
function boot(enabled = true) {
    const options = signedOut({authReact: true});
    return {...options, boot: {...options.boot, browseSite: {response: {
        site: {...siteResponse().site, authReact: true, ...(enabled ? {gatherSites: {apiOrigin, creationEnabled: false, version: 1}} : {})},
    }}}};
}
beforeEach(() => {
    sessionStorage.clear();
    fakeSetupStatus();
    fakeEndpoint('GET', apiOrigin + '/v1/auth/providers', {email: true, phone: true, social: ['google']});
});
it('handles an older backend without starting a signup or provisioning request', async () => {
    await renderAdminApp('/sites', boot(false));
    await expect.element(page.getByText('Site management is not available on this server yet.')).toBeVisible();
    await expect.element(page.getByRole('link', {name: 'Back to sign in'})).toBeVisible();
});
it('opens the shared Moments signup modal without a publication staff account', async () => {
    fakeAdminEndpoint('GET', '/gather/session/', {code: 'authentication_required'}, {status: 401});
    fakeEndpoint('GET', apiOrigin + '/v1/me', {code: 'authentication_required'}, {status: 401});
    await renderAdminApp('/sites', boot());
    await page.getByRole('button', {name: 'Create an account'}).click();
    await expect.element(page.getByLabelText('Phone or Email')).toBeVisible();
    await expect.element(page.getByRole('button', {name: 'Continue with Google'})).toBeVisible();
    await expect.element(page.getByLabelText('Password')).not.toBeInTheDocument();
});
it('shows only server-authorized sites and keeps creation disabled before isolation readiness', async () => {
    fakeAdminEndpoint('GET', '/gather/session/', {user: {id: workspace, name: 'Ben'},
        workspaces: [{id: workspace, name: 'Frontro', role: 'owner'}], csrfToken: 'a'.repeat(64), creationEnabled: false});
    fakeAdminEndpoint('GET', '/gather/sites/', {sites: [{id: workspace, name: 'Gather', hostname: 'gather.example.test', status: 'active', verified_at: '2026-10-05'}]});
    const create = fakeAdminEndpoint('POST', '/gather/sites/', {});
    await renderAdminApp('/sites', boot());
    await expect.element(page.getByRole('link', {name: 'Edit site'})).toHaveAttribute('href', 'https://gather.example.test/ghost/');
    await expect.element(page.getByRole('button', {name: 'Create site', exact: true})).toBeDisabled();
    expect(create.requests).toHaveLength(0);
});
