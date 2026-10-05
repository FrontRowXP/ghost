const { agentProvider, configUtils } = require('../../utils/e2e-framework');

describe('Frontro staff authentication API', function () {
  let agent;
  beforeAll(async function () {
    agent = await agentProvider.getAdminAPIAgent();
  });
  afterEach(function () {
    configUtils.set('security:frontroAuth', undefined);
  });

  it('does not advertise staff authentication on an older or disabled configuration', async function () {
    configUtils.set('security:frontroAuth', undefined);
    const response = await agent.get('site').expectStatus(200);
    expect(response.body.site.frontroAuth).toBeUndefined();
  });

  it('advertises only the API origin and serves the React screen when enabled', async function () {
    configUtils.set('security:frontroAuth', {
      enabled: true, apiOrigin: 'https://api.moments.frontro.com',
      staff: { '12345678-1234-1234-1234-123456789abc': 'private-staff-id' },
    });
    const response = await agent.get('site').expectStatus(200);
    expect(response.body.site.frontroAuth).toEqual({ apiOrigin: 'https://api.moments.frontro.com' });
    expect(response.body.site.authReact).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('private-staff-id');
  });

  it('cannot complete a login without a server-held handoff', async function () {
    configUtils.set('security:frontroAuth', {
      enabled: true, apiOrigin: 'https://api.moments.frontro.com', staff: {},
    });
    agent.clearCookies();
    // No outbound API request is needed or permitted for this failure.
    await agent.post('authentication/frontro/complete').body({}).expectStatus(401);
  });
});
