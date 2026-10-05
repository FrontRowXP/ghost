import type {SocialAuthOption} from './nugs/types';

const socialProviders:readonly SocialAuthOption[]=['google','apple','facebook','linkedin','x','discord'];
const handoffPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Browser visitors start on the public site. Native sign-in and an active
// connection handoff must remain in the app to complete their original flow.
export function signedOutDestination(currentURL:string,native=false):string|null {
 const current=new URL(currentURL);
 if(native||handoffPattern.test(current.searchParams.get('connect')||''))return null;
 const target=new URL('/marketing/index.html',current.origin);
 target.searchParams.set('clean','1');
 const mode=current.searchParams.get('auth');
 if(mode==='login'||mode==='signup')target.searchParams.set('auth',mode);
 return target.href;
}

function socialProvider(value:string|null):SocialAuthOption|null {
 return socialProviders.includes(value as SocialAuthOption)?value as SocialAuthOption:null;
}

export function nativeConnectURL(origin:string,id:string,provider:SocialAuthOption):string {
 const target=new URL('/',origin);
 if(!handoffPattern.test(id))throw new Error('Invalid handoff ID');
 target.searchParams.set('connect',id);target.searchParams.set('provider',provider);
 return target.href;
}

export function requestedConnectProvider(currentURL:string,enabled:readonly string[]):SocialAuthOption|null {
 const current=new URL(currentURL);
 if(!handoffPattern.test(current.searchParams.get('connect')||''))return null;
 const provider=socialProvider(current.searchParams.get('provider'));
 return provider&&enabled.includes(provider)?provider:null;
}

export function hasConnectProviderIntent(currentURL:string):boolean {
 const current=new URL(currentURL);
 return handoffPattern.test(current.searchParams.get('connect')||'')&&socialProvider(current.searchParams.get('provider'))!==null;
}

// All successful auth paths land in the app. Keep only the validated native
// connection ID; marketing URLs, errors and arbitrary redirect query strings
// must not become OAuth return destinations.
export function appDestination(currentURL:string):string {
 const current=new URL(currentURL);
 const target=new URL('/',current.origin);
 const connect=current.searchParams.get('connect');
 if(connect&&handoffPattern.test(connect))target.searchParams.set('connect',connect);
 return target.href;
}

// A failed session check leaves public marketing usable. The liveness check
// prevents a request completed after unmount/HMR from unexpectedly navigating.
export async function redirectAuthenticatedVisitor(
 currentURL:string,
 checkSession:()=>Promise<unknown>,
 navigate:(url:string)=>void,
 isActive:()=>boolean=()=>true,
):Promise<void> {
 try {await checkSession();if(isActive())navigate(appDestination(currentURL))}
 catch {/* Anonymous or temporarily offline. */}
}
