const assert = require('node:assert/strict');
const { agentProvider } = require('../../utils/e2e-framework');

describe('Gather site management API capability boundary', function () {
  let agent;
  beforeAll(async function () {
    agent = await agentProvider.getAdminAPIAgent();
  });
  it('does not advertise a disabled site hub to existing or anonymous Admin', async function () {
    const response = await agent.get('site').expectStatus(200);
    assert.equal(response.body.site.gatherSites, undefined);
    agent.clearCookies();
    const anonymous = await agent.get('site').expectStatus(200);
    assert.equal(anonymous.body.site.gatherSites, undefined);
  });
  it('denies anonymous site discovery and creation while the hub is disabled', async function () {
    agent.clearCookies();
    await agent.get('gather/sites').expectStatus(404);
    await agent.get('gather/session').expectStatus(404);
    await agent.post('gather/sites').body({ workspaceId: 'untrusted' }).expectStatus(404);
  });
});
