/** Run against an isolated, initialized database using projected environment config. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('../core/shared/config').default || require('../core/shared/config');
const database = config.get('database');
assert.equal(database.client, 'pg', 'This check requires PostgreSQL');
assert.match(database.connection.database, /_(test|dev)(_|$)/, 'Use an isolated test database');
assert.equal(database.connection.ssl.rejectUnauthorized, true, 'Verify database TLS');

const knex = require('knex')({
  ...database,
  connection: { ...database.connection, options: '-c timezone=UTC' },
  pool: { min: 0, max: 3 },
});
const commands = require('../core/server/data/schema/commands');
const migrator = require('knex-migrator/lib/locking');
const migration = require('../core/server/data/migrations/versions/6.68/2026-09-29-19-59-04-make-automations-slug-nullable');

try {
  const { rows } = await knex.raw(
    "SELECT current_database() AS database, current_setting('TimeZone') AS timezone, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
  );
  assert.equal(rows[0].database, database.connection.database);
  assert.equal(rows[0].timezone, 'UTC');
  assert.equal(rows[0].ssl, true);
  assert.ok((await commands.getTables(knex)).includes('posts'));
  assert.ok((await commands.getColumns('posts', knex)).includes('slug'));
  assert.ok((await commands.getIndexes('posts', knex)).length > 0);
  const foreignKeys = await knex.raw(
    "SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid = 'posts'::regclass",
  );
  assert.ok(foreignKeys.rows.length > 0);
  console.log('PostgreSQL TLS, UTC, schema reflection and foreign keys: passed');

  await migrator.lock(knex);
  try {
    await assert.rejects(migrator.lock(knex), /Migrations are running/);
  } finally {
    await migrator.unlock(knex);
  }
  await migrator.isLocked(knex);
  console.log('Migration lock exclusion and release: passed');

  const transaction = await knex.transaction();
  try {
    await transaction('automations').insert({
      id: '000000000000000000000001',
      name: 'Gather migration acceptance',
      slug: null,
      created_at: new Date(),
    });
    await migration.down({ connection: transaction, transacting: transaction });
    assert.equal((await transaction('automations').columnInfo('slug')).nullable, false);
    const automation = await transaction('automations')
      .where({ id: '000000000000000000000001' })
      .first();
    assert.match(automation.slug, /^[a-f0-9-]{36}$/);
    await migration.up({ connection: transaction, transacting: transaction });
    assert.equal((await transaction('automations').columnInfo('slug')).nullable, true);
    await commands.addPrimaryKey('posts', 'id', transaction);
  } finally {
    await transaction.rollback();
  }
  assert.equal(
    await knex('automations').where({ id: '000000000000000000000001' }).first(),
    undefined,
  );
  assert.equal((await knex('automations').columnInfo('slug')).nullable, true);
  console.log('Latest migration rollback/upgrade and transaction rollback: passed');
} finally {
  await knex.destroy();
  // Reflection loads Ghost's lazy database singleton; close it too.
  await require('../core/server/data/db').knex.destroy();
}
