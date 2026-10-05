// Scheduler tokens retain their canonical audience. Only the transport changes
// to this fixed worker; no callback may select a sibling site or remote target.
exports.tenantCallback = function tenantCallback(url, config) {
  if (!config.get('gather:tenant:siteId')) return {url};
  const target = new URL(url);
  const origin = new URL(config.get('url'));
  const port = config.get('server:port');
  const secret = config.get('security:gatherOriginSecret');
  if (target.origin !== origin.origin || target.username || target.password || target.hash ||
      !target.pathname.startsWith('/ghost/api/admin/') || !Number.isInteger(port) || port < 2370 || port > 2377 ||
      config.get('server:host') !== '127.0.0.1' || typeof secret !== 'string' || secret.length < 48) {
    throw new Error('A tenant scheduler callback must address its fixed Admin runtime');
  }
  return {url: `http://127.0.0.1:${port}${target.pathname}${target.search}`, headers: {
    Host: origin.host, 'X-Forwarded-Proto': 'https', 'X-Gather-Origin-Key': secret,
  }};
};
