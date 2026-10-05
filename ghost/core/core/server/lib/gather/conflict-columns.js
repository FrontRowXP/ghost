const config = require('../../../shared/config');

// Fixed-site workers use semantic uniqueness within their immutable login scope.
module.exports = function conflictColumns(columns) {
  const names = Array.isArray(columns) ? columns : [columns];
  return config.get('gather:tenant:siteId') ? ['site_id', ...names] : columns;
};
