import {useEffect,useRef,useState,type FormEvent} from 'react';
import {AuthError,authMessage,authRequest as apiRequest,gatherOAuthReturnURL,type Providers} from './client';
import {AuthGlassCard} from './nugs/AuthGlassCard';
import {AuthCardHeader} from './nugs/AuthCardHeader';
import {AuthSocialRow} from './nugs/AuthSocialRow';
import {AuthIdentityInput} from './nugs/AuthIdentityInput';
import {detectIdentityKind} from './nugs/identityDetection';
import type {SocialAuthOption} from './nugs/types';
import {MotionConfig} from 'framer-motion';
import {hasConnectProviderIntent,nativeConnectURL,requestedConnectProvider} from './navigation';
// The approved nugs prototype presentation uses the standalone Moments REST API.
type Handoff={id:string;secret:string;code:string;expiresIn:number};
declare global {interface Window {ReactNativeWebView?:{postMessage:(message:string)=>void};momentsDesktop?:{openAuth:(url:string)=>Promise<void>;getInstallInfo:()=>Promise<unknown>}}}
const providerLabels:Record<string,string>={google:'Google',apple:'Apple',facebook:'Facebook',linkedin:'LinkedIn',x:'X',discord:'Discord'};
export function AuthModal({onAuthenticated,initialMode='login',onClose=()=>location.assign('/'),apiOrigin}:{onAuthenticated:()=>Promise<void>;initialMode?:'login'|'signup';onClose?:()=>void;apiOrigin:string}) {
 function authRequest<T>(path:string,body?:unknown,csrf?:string){return apiRequest<T>(path,body,csrf,20000,undefined,apiOrigin)}
 const [mode,setMode]=useState<'login'|'signup'>(initialMode),[identity,setIdentity]=useState(''),[code,setCode]=useState('');
 const [providers,setProviders]=useState<Providers|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[challenge,setChallenge]=useState(''),[verified,setVerified]=useState(false),[retryAt,setRetryAt]=useState(0),[seconds,setSeconds]=useState(0);
 const [handoff,setHandoff]=useState<(Handoff&{provider:SocialAuthOption})|null>(null);const generation=useRef(0),starting=useRef(false),browserIntentStarted=useRef(false);
 const native=!!window.ReactNativeWebView||!!window.momentsDesktop;
 const isPhone=detectIdentityKind(identity)==='phone';
 const [country,setCountry]=useState('US'),[dialCode,setDialCode]=useState('+1');
 const phone=identity.trim().replace(/[\s().-]/g,'');
 const normalizedIdentity=isPhone?(phone.startsWith('+')?phone:dialCode+phone):identity.trim();
 async function loadProviders(){try{setProviders(await authRequest<Providers>('/auth/providers'));setError('')}catch(e){setError(authMessage(e))}}
 useEffect(()=>{void loadProviders()},[]);
 useEffect(()=>{
  if(native||!providers||browserIntentStarted.current)return;
  if(!hasConnectProviderIntent(location.href))return;
  browserIntentStarted.current=true;
  const provider=requestedConnectProvider(location.href,providers.social);
  if(provider)void social(provider);
  else setError('The selected sign-in provider is not available. Please choose another.');
 },[native,providers]);
 useEffect(()=>{const tick=()=>setSeconds(Math.max(0,Math.ceil((retryAt-Date.now())/1000)));tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer)},[retryAt]);
 useEffect(()=>{
  if(!handoff)return;
  let active=true;let timer:ReturnType<typeof setTimeout>;
  const expires=Date.now()+handoff.expiresIn*1000;
  const poll=async()=>{if(!active)return;if(Date.now()>expires){starting.current=false;setHandoff(null);setError('The connection expired. Please try again.');return}
   try{const result=await authRequest<{authenticated?:boolean}>('/auth/handoffs/'+handoff.id+'/exchange',{secret:handoff.secret});if(active&&result.authenticated){setHandoff(null);await onAuthenticated();return}}
   catch(e){if(active&&e instanceof AuthError&&e.status<500&&e.status!==429){starting.current=false;setError(authMessage(e));setHandoff(null);return}}
   if(active)timer=setTimeout(poll,3000);
  };void poll();return()=>{active=false;clearTimeout(timer)};
 },[handoff,onAuthenticated]);
 async function send(){
  if(!identity.trim()){setError('Enter your phone number or email.');return}
  if(!(isPhone?providers?.phone:providers?.email)){setError((isPhone?'Phone':'Email')+' sign-in is not configured yet.');return}
  setBusy(true);setError('');
  try {const result=await authRequest<{challengeId:string;retryAfter:number}>('/auth/challenges',{kind:isPhone?'phone':'email',identity:normalizedIdentity});setChallenge(result.challengeId);setVerified(false);setCode('');setRetryAt(Date.now()+result.retryAfter*1000)}
  catch(e){setError(authMessage(e));if(e instanceof AuthError&&e.retryAfter)setRetryAt(Date.now()+e.retryAfter*1000)}finally{setBusy(false)}
 }
 async function submit(e:FormEvent){e.preventDefault();if(!challenge){await send();return}setBusy(true);setError('');try{if(!verified){await authRequest('/auth/challenges/'+challenge+'/verify',{code,termsAccepted:true});setVerified(true)}await onAuthenticated()}catch(e){setError(authMessage(e))}finally{setBusy(false)}}
 async function social(provider:SocialAuthOption){if(starting.current)return;if(!providers?.social.includes(provider)){setError('The selected sign-in provider is not available. Please choose another.');return}starting.current=true;setBusy(true);setError('');try{const {url}=await authRequest<{url:string}>('/auth/oauth/'+provider+'/start',{returnTo:gatherOAuthReturnURL(location.href),termsAccepted:true,selectAccount:provider==='google'});location.assign(url)}catch(e){starting.current=false;setError(authMessage(e));setBusy(false)}}
 async function connectApp(provider:SocialAuthOption){if(starting.current)return;if(!providers?.social.includes(provider)){setError('The selected sign-in provider is not available. Please choose another.');return}starting.current=true;const current=++generation.current;setBusy(true);setError('');try{
  const result=await authRequest<Handoff>('/auth/handoffs',{});if(current!==generation.current)return;setHandoff({...result,provider});
 }catch(e){starting.current=false;setError(authMessage(e))}finally{setBusy(false)}}
 function openBrowser(){if(!handoff)return;const url=nativeConnectURL(location.origin,handoff.id,handoff.provider);if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'moments.auth.open',url}));else void window.momentsDesktop?.openAuth(url).catch(e=>setError(authMessage(e)))}
 const socialProviders:SocialAuthOption[]=(['google','facebook','linkedin','x','apple','discord'] as SocialAuthOption[]).filter(p=>providers?.social.includes(p));
 const identityEnabled=!!(providers?.email||providers?.phone);
 return <MotionConfig reducedMotion="user"><main className="auth-screen auth-surface" aria-labelledby="auth-title">
  <AuthGlassCard variant="prototype" testId="welcome-auth-v2-card" className="relative my-auto mx-auto w-full max-w-[440px] max-h-[calc(100dvh-2rem)] overflow-y-auto" onFocusCapture={e=>{if(e.target instanceof HTMLInputElement){const input=e.target;setTimeout(()=>{const bounds=input.getBoundingClientRect();if(bounds.bottom>(window.visualViewport?.height||innerHeight)||bounds.top<0)input.scrollIntoView({block:'center',behavior:'smooth'})},300)}}}>
   <AuthCardHeader title={handoff?'Continue in your browser':verified?'Finish signing in':challenge?'Check your '+(isPhone?'phone':'email'):mode==='signup'?'Sign up':'Sign in'} onClose={native?undefined:onClose} onBack={challenge||handoff?()=>{generation.current++;starting.current=false;setHandoff(null);setChallenge('');setVerified(false);setCode('');setError('')}:undefined}/>
   {handoff?<>
    <p className="text-sm text-white/70">Use this code to connect your app after signing in.</p>
    <output className="auth-connection-code" aria-label="App connection code">{handoff.code.slice(0,4)}-{handoff.code.slice(4)}</output>
    <button className="auth-primary" onClick={openBrowser}>Open browser to sign in</button>
    <p className="auth-caption">Return here after connecting. This code expires in 10 minutes.</p>
   </>:<>
    {!challenge&&socialProviders.length>0&&<div className="pb-6"><AuthSocialRow variant="prototype" dividerLabel="or" disabled={busy} providerLabelPrefix="Continue with" providers={socialProviders.map(option=>({option,title:providerLabels[option],imageUrl:null,loginUrl:'/v1/auth/oauth/'+option+'/start'}))} onProviderClick={provider=>void (native?connectApp(provider):social(provider))}/></div>}
    <form onSubmit={submit} aria-busy={busy} className="flex w-full flex-col gap-5">
     {verified?<p className="text-sm text-white/70" role="status">Your code is verified. Continue to finish signing in.</p>:challenge?<div>
      <p className="mb-4 text-sm text-white/70">Enter the six-digit code sent to {normalizedIdentity}.</p>
      <label className="block text-sm font-medium text-white" htmlFor="auth-code">Verification code</label>
      <input className="auth-code-input mt-2" id="auth-code" autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} placeholder="000000" required disabled={busy}/>
     </div>:<AuthIdentityInput isPrototype country={country} disabled={busy||!identityEnabled} emailAutoComplete={mode==='signup'?'email':'username'} labels={{email:'Email',phone:'Phone number',neutral:'Phone or Email'}} placeholders={{email:'Email',phone:'(201) 555-0123',neutral:'Phone or email'}} name="identity-value" onChange={value=>{setIdentity(value);setError('')}} onDialCodeChange={(dial,nextCountry)=>{setDialCode(dial);setCountry(nextCountry)}} testId="welcome-auth-v2-identity-field" value={identity}/>}
     {!challenge&&providers&&(!providers.email||!providers.phone)&&<p className="auth-caption" role="status">{!identityEnabled?'Email and phone sign-in are currently unavailable.':!providers.phone?'Phone sign-in is currently unavailable. Use your email address.':!providers.email?'Email sign-in is currently unavailable. Use your phone number.':''}{!identityEnabled&&socialProviders.length>0?' Choose a sign-in option above to continue.':''}</p>}
     <div className="flex flex-col gap-3">
      <button className="auth-primary" type="submit" disabled={busy||!providers||(!challenge&&(!identityEnabled||seconds>0))}>{busy?'Please wait…':verified?'Try again':challenge?'Verify and continue':seconds>0?`Continue in ${seconds}s`:'Continue'}</button>
      {!verified&&<p className="!m-0 text-[10px] leading-[1.55] text-left text-white/70" data-testid="terms-acceptance-text">By clicking {challenge?'Verify and continue':'Continue'}, you agree to our <a className="!font-bold !underline !text-white" href="https://frontro.com/terms" target="_blank" rel="noreferrer">Terms of Service</a> and <a className="!font-bold !underline !text-white" href="https://frontro.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.<br/>You acknowledge that you’re at least 18 years old.</p>}
     </div>
    </form>
    {challenge?(!verified&&<div className="auth-code-actions"><button disabled={busy||seconds>0} onClick={()=>void send()}>{seconds>0?`Resend code in ${seconds}s`:'Resend code'}</button></div>):<div className="mt-9 flex justify-center gap-1 text-sm"><span className="text-white/70">{mode==='login'?"Don't have an account?":'Already have an account?'}</span><button type="button" className="cursor-pointer border-none bg-transparent p-0 text-sm font-medium text-white underline" disabled={busy} onClick={()=>{setMode(mode==='login'?'signup':'login');setError('')}}>{mode==='login'?'Sign up':'Log in'}</button></div>}
    {providers&&!identityEnabled&&socialProviders.length===0&&<p className="auth-caption">Sign-in is unavailable on this server. Please try again later.</p>}
    {!providers&&error&&<button className="auth-text-button" onClick={()=>void loadProviders()}>Retry connection</button>}
   </>}
   {error&&<p className="auth-error" role="alert">{error}</p>}
  </AuthGlassCard>
 </main></MotionConfig>;
}
