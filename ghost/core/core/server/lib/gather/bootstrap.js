const {randomBytes} = require('node:crypto');

// Runs in a fixed-role worker. Every write, including fixture relations, is
// enforced by PostgreSQL. The owner ID is durable before this worker starts.
exports.bootstrapTenant = async function bootstrapTenant(config, database) {
  const tenant = config.get('gather:tenant');
  if (!/^[a-f0-9]{24}$/.test(tenant.ownerStaffId) || !/^[a-f0-9-]{36}$/.test(tenant.ownerSubject)) {
    throw new Error('Invalid provisioned owner binding');
  }
  const models = require('../../models');
  const {FixtureManager} = require('../../data/schema/fixtures');
  const fixtures = structuredClone(require('../../data/schema/fixtures/fixtures.json'));
  const owner = fixtures.models.find(model => model.name === 'User').entries[0];
  // New publications start empty; upstream demo pages promote Ghost and refer
  // to membership features the owner has not configured.
  fixtures.models.find(model => model.name === 'Post').entries = [];
  owner.name = tenant.ownerName || 'Frontro publisher';
  owner.email = `${tenant.ownerSubject}@accounts.frontro.invalid`;
  // Never enable a local password flow for a Moments-created staff account.
  owner.password = randomBytes(48).toString('hex');
  owner.status = 'active';
  const manager = new FixtureManager(fixtures, {__OWNER_USER_ID__: () => tenant.ownerStaffId});
  await database.transaction(async transacting => {
    await transacting.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ['gather-bootstrap:' + tenant.siteId]);
    await manager.addAllFixtures({transacting});
  });
  await models.Settings.populateDefaults();
  await database('settings').where({key: 'title'}).update({value: tenant.siteName});
  await database('settings').where({key: 'site_uuid'}).update({value: tenant.siteId});
  await database('settings').where({key: 'members_signup_access'}).update({value: 'none'});
  await database('settings').where({key: 'icon'}).update({value: config.get('url') + '/public/frontro/icon.png'});
  await database('settings').where({key: 'logo'}).update({value: config.get('url') + '/public/frontro/logo.svg'});
  await database('settings').whereIn('key', ['facebook', 'twitter', 'cover_image']).update({value: null});
  await database('settings').where({key: 'description'}).update({value: ''});
  await database('settings').where({key: 'navigation'}).update({value: JSON.stringify([{label: 'Home', url: '/'}])});
  await database('settings').where({key: 'secondary_navigation'}).update({value: '[]'});
};
