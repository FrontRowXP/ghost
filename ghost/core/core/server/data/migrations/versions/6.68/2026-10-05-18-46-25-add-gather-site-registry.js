const { addTable, combineNonTransactionalMigrations } = require('../../utils');
// Frozen migration definition: do not load the current schema here.
const tables = {
  gather_sites: {
    id: {
      type: 'string',
      maxlength: 36,
      nullable: false,
      primary: true,
    },
    workspace_id: {
      type: 'string',
      maxlength: 36,
      nullable: false,
    },
    name: {
      type: 'string',
      maxlength: 191,
      nullable: false,
    },
    slug: {
      type: 'string',
      maxlength: 63,
      nullable: false,
      unique: true,
    },
    status: {
      type: 'string',
      maxlength: 32,
      nullable: false,
      defaultTo: 'provisioning',
    },
    created_by: {
      type: 'string',
      maxlength: 36,
      nullable: false,
    },
    created_at: {
      type: 'dateTime',
      nullable: false,
    },
    updated_at: {
      type: 'dateTime',
      nullable: false,
    },
  },
  gather_site_domains: {
    id: {
      type: 'string',
      maxlength: 36,
      nullable: false,
      primary: true,
    },
    site_id: {
      type: 'string',
      maxlength: 36,
      nullable: false,
      references: 'gather_sites.id',
      cascadeDelete: true,
    },
    hostname: {
      type: 'string',
      maxlength: 253,
      nullable: false,
      unique: true,
    },
    verified_at: {
      type: 'dateTime',
      nullable: true,
    },
    is_primary: {
      type: 'boolean',
      nullable: false,
      defaultTo: false,
    },
  },
  gather_site_staff: {
    id: {
      type: 'string',
      maxlength: 36,
      nullable: false,
      primary: true,
    },
    site_id: {
      type: 'string',
      maxlength: 36,
      nullable: false,
      references: 'gather_sites.id',
      cascadeDelete: true,
    },
    subject_id: {
      type: 'string',
      maxlength: 36,
      nullable: false,
    },
    staff_id: {
      type: 'string',
      maxlength: 24,
      nullable: false,
      references: 'users.id',
      cascadeDelete: true,
    },
    '@@UNIQUE_CONSTRAINTS@@': [
      ['site_id', 'subject_id'],
      ['site_id', 'staff_id'],
    ],
  },
};
module.exports = combineNonTransactionalMigrations(
  ...Object.entries(tables).map(([name, spec]) => addTable(name, spec)),
);
