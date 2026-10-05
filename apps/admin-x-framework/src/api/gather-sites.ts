import { apiUrl } from '../utils/api/fetch-api';

export class SiteManagementError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// The site hub has an independent workspace session and CSRF token. A 401 must
// remain an anonymous hub state, rather than redirect to publication staff auth.
// Writes are never retried: handoffs are single-use and provisioning needs its
// own server-side idempotency protocol before creation can be enabled.
export async function gatherSitesRequest<T>(
  path: string,
  body?: unknown,
  csrf?: string,
  method?: string,
): Promise<T> {
  const response = await fetch(apiUrl('/gather/' + path), {
    method: method || (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data: { code?: string } = await response.json().catch(() => ({}));
    throw new SiteManagementError(data.code || 'site_management_unavailable', response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
