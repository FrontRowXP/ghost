export type Subscription = {plan:string;status:string;cancelledAt:string|null;renewalAt:string|null};
export type Entitlements = {plan:string;storageLimitBytes:number;usedBytes:number;reservedBytes:number;availableBytes:number;overLimit:boolean;aiPasses:number;videoGenerations?:{limit:number;used:number;reserved:number;remaining:number;periodStart:string|null;periodEnd:string|null}};
export type BillingStatus={planChange?:{status:string;target:string;effectiveAt:string};provider?:'stripe'|'apple'|'google';state:string;plan:string;periodEnd:string|null;lastVerifiedAt:string|null;resubscriptionEligible:boolean};
export type Session = {entitlements?:Entitlements;billing?:BillingStatus;user:{id:string;name:string;csrfToken:string;profileImageUrl?:string;createdAt?:string};subscription?:Subscription;workspaces:{id:string;name:string;role:string}[]};
export type Providers = {email:boolean;phone:boolean;social:string[]};
export class AuthError extends Error {
  code:string;status:number;retryAfter:number;
  constructor(code:string,status:number,retryAfter=0) {super(code);this.code=code;this.status=status;this.retryAfter=retryAfter;}
}
export async function authRequest<T>(path:string, body?:unknown, csrf?:string, timeoutMs=20000, method?:'PUT',apiOrigin=''):Promise<T> {
  const response = await fetch(apiOrigin+'/v1'+path, {
    method:method||(body === undefined?'GET':'POST'), credentials:'include', cache:'no-store',
    headers:body === undefined?{}:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},
    body:body === undefined?undefined:JSON.stringify(body), signal:AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const data = await response.json().catch(()=>({}));
    throw new AuthError(data.code || 'auth_unavailable', response.status, Number(response.headers.get('Retry-After')) || 0);
  }
  return response.status===204?undefined as T:response.json();
}
export async function authDelete(path:string, csrf:string):Promise<void> {
  const response=await fetch('/v1'+path, {
    method:'DELETE', credentials:'include', cache:'no-store',
    headers:{'X-CSRF-Token':csrf}, signal:AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const data:{code?:string;error?:string}=await response.json().catch(()=>({}));
    throw new AuthError(data.code||data.error||'auth_unavailable',response.status);
  }
}
export function authMessage(error:unknown):string {
  const messages:Record<string,string> = {
    frontro_staff_access_required:'Your Frontro account does not have access to this publication. Contact its owner.',
    frontro_auth_unavailable:'Unable to connect to Gather. Please try again.',
    frontro_handoff_expired:'This sign-in connection expired. Please try again.',
    frontro_handoff_pending:'This sign-in connection was not approved. Please try again.',
    apple_requires_https:'Apple sign-in requires an HTTPS development address.',
    invalid_return_url:'This app address is not configured for social sign-in.',
    invalid_identity:'Enter a valid email address or phone number with country code.',
    invalid_code:'That code is not correct. Please try again.',
    invalid_challenge:'This code has expired or reached its attempt limit. Request a new code.',
    invalid_handoff:'This app connection has expired. Start again in the app.',
    terms_required:'Please accept the terms to create your account.',
    method_unavailable:'This sign-in method is not available yet. Please choose another.',
    delivery_unavailable:'We could not send your code. Please try again shortly.',
    verification_unavailable:'We could not check your code. Please try again.',
    account_unavailable:'This account is unavailable. Contact support.',
    rate_limited:'Too many attempts. Please wait before trying again.',
    origin_denied:'This app address is not configured for sign-in.',
    csrf_invalid:'Your session changed. Refresh and try again.',
  };
  return error instanceof AuthError?messages[error.code] || 'Sign-in is temporarily unavailable. Please try again.':'Unable to reach Moments. Check your connection and try again.';
}

/** OAuth return URLs must not contain the Ghost hash router fragment. */
export function gatherOAuthReturnURL(currentURL: string): string {
  const url = new URL(currentURL);
  return url.origin + url.pathname;
}
