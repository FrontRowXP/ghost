// Nugs AuthCardHeader prototype branch. Only channel, routing and translation
// dependencies are replaced by Moments props; markup/classes remain upstream.
import {ArrowLeft, X} from 'lucide-react';
import frontroLogo from './frontro-logo.svg';
export function AuthCardHeader({title,onBack,onClose}:{title:string;onBack?:()=>void;onClose?:()=>void}) {
 return <div className="flex flex-col gap-6 pb-6">
  <div className="flex min-h-10 items-center gap-2.5" data-testid="welcome-auth-v2-header-row">
   <div className={onBack?'flex justify-start':'hidden'}>{onBack&&<button type="button" aria-label="Back" className="text-white/60 transition-colors hover:text-white" onClick={onBack}><ArrowLeft className="h-5 w-5"/></button>}</div>
   <div className="flex flex-1 justify-start"><a aria-label="Frontro Gather home" className="block" href="/"><img alt="Frontro" className="block h-10 w-auto max-w-[180px] object-contain" data-testid="welcome-auth-v2-logo" src={frontroLogo}/></a></div>
   <div className="flex size-10 justify-end [&>button]:flex [&>button]:size-10 [&>button]:items-center [&>button]:justify-center">{onClose&&<button aria-label="Close" className="text-white/60 transition-colors hover:text-white" onClick={onClose} type="button"><X className="h-5 w-5"/></button>}</div>
  </div>
  <h1 id="auth-title" className="text-center text-[22px] font-medium tracking-[-0.02em] text-white" data-testid="welcome-auth-v2-tagline">{title}</h1>
 </div>;
}
