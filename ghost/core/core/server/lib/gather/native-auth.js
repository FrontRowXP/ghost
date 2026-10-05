exports.nativeAuthUnavailable = function nativeAuthUnavailable(method, path) {
  const route = path.replace(/\/$/, '');
  return method === 'POST' && route === '/session' ||
    route.startsWith('/authentication/password_reset') ||
    route.startsWith('/authentication/invitation') ||
    method !== 'GET' && route.startsWith('/authentication/setup') ||
    route === '/authentication/reset';
};
