import { Command, CommandContext } from './index';

/**
 * seed: Copy a Shiro seed to clipboard — full state snapshot
 *
 * Serializes the entire IndexedDB filesystem + localStorage into a
 * self-contained snippet using NDJSON format for incremental parsing.
 * When pasted into any browser's DevTools console, it creates a floating
 * Shiro iframe and hydrates it with the captured state without blocking.
 */

const SHIRO_VERSION = '0.1.0';

// Minimal pako deflate for gzip compression (will be loaded dynamically)
declare const pako: { gzip: (data: Uint8Array) => Uint8Array };

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

interface SeedStats {
  version: string;
  files: number;
  dirs: number;
  totalBytes: number;
  sizeKB: number;
  sizeMB: string;
  detectedKeys: string[];  // Names of detected keys (not values)
}

/** Detect API keys in localStorage by common patterns */
function detectApiKeys(storage: Record<string, string>): string[] {
  const detected: string[] = [];
  const keyPatterns: Array<{ name: string; pattern: RegExp }> = [
    { name: 'OpenAI', pattern: /^sk-[a-zA-Z0-9-_]{20,}$/ },
    { name: 'Anthropic', pattern: /^sk-ant-[a-zA-Z0-9-_]{20,}$/ },
    { name: 'Google', pattern: /^AIza[a-zA-Z0-9-_]{30,}$/ },
    { name: 'GitHub', pattern: /^gh[ps]_[a-zA-Z0-9]{36,}$/ },
    { name: 'Stripe', pattern: /^sk_(test|live)_[a-zA-Z0-9]{20,}$/ },
    { name: 'AWS', pattern: /^AKIA[A-Z0-9]{16}$/ },
  ];

  for (const [key, value] of Object.entries(storage)) {
    // Check key name for hints
    const keyLower = key.toLowerCase();
    if (keyLower.includes('key') || keyLower.includes('token') || keyLower.includes('secret')) {
      // Check value against patterns
      for (const { name, pattern } of keyPatterns) {
        if (pattern.test(value)) {
          detected.push(name);
          break;
        }
      }
      // Also flag generic-looking keys
      if (value.length > 20 && /^[a-zA-Z0-9-_]+$/.test(value) && !detected.includes(key)) {
        const keyName = key.replace(/^shiro_/, '').replace(/_/g, ' ');
        if (!detected.some(d => keyName.toLowerCase().includes(d.toLowerCase()))) {
          detected.push(keyName);
        }
      }
    }
  }

  return [...new Set(detected)];  // Dedupe
}

function buildSnippet(url: string, ndjson: string, storage: string, stats: SeedStats): string {
  // Escape for embedding in template literal
  const escapeForTemplate = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const escapedNdjson = escapeForTemplate(ndjson);
  const escapedStorage = escapeForTemplate(storage);

  // Build header comment with stats
  const header = `// shiro seed v${stats.version} | ${stats.files} files, ${stats.dirs} dirs | ${stats.sizeMB} MB`;

  return `${header}
(function(){
  if(document.getElementById('shiro-seed')){console.log('Shiro already seeded');return}
  var w=document.createElement('div');w.id='shiro-seed';
  var S=w.style;S.position='fixed';S.bottom='20px';S.right='20px';S.width='32em';S.height='22em';
  S.zIndex='2147483647';S.borderRadius='8px';S.overflow='hidden';
  S.boxShadow='rgb(206,170,227) 0px 5px 11px -3px';S.opacity='0.88';S.backdropFilter='blur(8px)';
  S.fontFamily='-apple-system,BlinkMacSystemFont,sans-serif';S.display='flex';S.flexDirection='column';
  var tb=document.createElement('div');
  var T=tb.style;T.background='#1a1a2e';T.height='32px';T.display='flex';T.alignItems='center';
  T.padding='0 10px';T.cursor='grab';T.userSelect='none';T.flexShrink='0';
  var dots=document.createElement('div');dots.style.display='flex';dots.style.gap='6px';
  var close=document.createElement('div');var cs=close.style;
  cs.width='12px';cs.height='12px';cs.borderRadius='50%';cs.background='#ff5f57';cs.cursor='pointer';
  close.onclick=function(){w.remove()};
  var mini=document.createElement('div');var ms=mini.style;
  ms.width='12px';ms.height='12px';ms.borderRadius='50%';ms.background='#febc2e';ms.cursor='pointer';
  var minimized=false;
  mini.onclick=function(){
    minimized=!minimized;
    iframe.style.display=minimized?'none':'block';
    rh.style.display=minimized?'none':'block';
    w.style.height=minimized?'32px':savedH+'px';
  };
  dots.appendChild(close);dots.appendChild(mini);
  var title=document.createElement('span');title.textContent='shiro';
  var ts=title.style;ts.color='#8888cc';ts.fontSize='13px';ts.fontWeight='600';ts.marginLeft='10px';ts.flex='1';
  /* Font size controls - hidden until hover */
  var fontSize=14;
  var zoomWrap=document.createElement('div');zoomWrap.style.cssText='display:flex;gap:4px;opacity:0;transition:opacity 0.15s';
  var zoomOut=document.createElement('div');zoomOut.textContent='−';
  zoomOut.style.cssText='width:14px;height:14px;border-radius:50%;background:#555;color:#fff;font-size:12px;line-height:14px;text-align:center;cursor:pointer';
  var zoomIn=document.createElement('div');zoomIn.textContent='+';
  zoomIn.style.cssText='width:14px;height:14px;border-radius:50%;background:#555;color:#fff;font-size:12px;line-height:14px;text-align:center;cursor:pointer';
  zoomOut.onclick=function(e){e.stopPropagation();fontSize=Math.max(8,fontSize-1);iframe.contentWindow.postMessage({type:'shiro-fontsize',size:fontSize},'*')};
  zoomIn.onclick=function(e){e.stopPropagation();fontSize=Math.min(24,fontSize+1);iframe.contentWindow.postMessage({type:'shiro-fontsize',size:fontSize},'*')};
  zoomWrap.appendChild(zoomOut);zoomWrap.appendChild(zoomIn);
  tb.onmouseenter=function(){zoomWrap.style.opacity='1'};
  tb.onmouseleave=function(){zoomWrap.style.opacity='0'};
  tb.appendChild(dots);tb.appendChild(title);tb.appendChild(zoomWrap);
  var iframe=document.createElement('iframe');iframe.src='${url}';
  var is=iframe.style;is.border='none';is.width='100%';is.flex='1';is.background='#0a0a1a';
  iframe.allow='clipboard-read; clipboard-write';
  var rh=document.createElement('div');var rs=rh.style;
  rs.position='absolute';rs.bottom='0';rs.right='0';rs.width='16px';rs.height='16px';
  rs.cursor='nwse-resize';rs.background='linear-gradient(135deg,transparent 50%,#555 50%)';
  w.appendChild(tb);w.appendChild(iframe);w.appendChild(rh);
  document.body.appendChild(w);
  var dx=0,dy=0,sx=0,sy=0,dragging=false;
  tb.onmousedown=function(e){dragging=true;sx=e.clientX;sy=e.clientY;
    var r=w.getBoundingClientRect();dx=r.left;dy=r.top;
    tb.style.cursor='grabbing';e.preventDefault()};
  document.addEventListener('mousemove',function(e){
    if(dragging){w.style.left=(dx+e.clientX-sx)+'px';w.style.top=(dy+e.clientY-sy)+'px';
      w.style.right='auto';w.style.bottom='auto'}
    if(resizing){var rr=w.getBoundingClientRect();
      var nw=Math.max(300,e.clientX-rr.left);var nh=Math.max(200,e.clientY-rr.top);
      w.style.width=nw+'px';w.style.height=nh+'px';savedH=nh}});
  document.addEventListener('mouseup',function(){dragging=false;resizing=false;tb.style.cursor='grab'});
  var resizing=false,savedH=w.offsetHeight||352;
  rh.onmousedown=function(e){resizing=true;e.preventDefault();e.stopPropagation()};
  /* NDJSON seed data - parsed incrementally */
  var SEED_FS=\`${escapedNdjson}\`;
  var SEED_STORAGE=\`${escapedStorage}\`;
  var seeded=false;
  iframe.onload=function(){
    if(seeded)return;seeded=true;
    iframe.contentWindow.postMessage({type:'shiro-seed-v2',ndjson:SEED_FS,storage:SEED_STORAGE},'*');
  };
  /* HC bridge: lets the Shiro iframe run HC commands against the host DOM */
  (function(){
    var cur=document.body,lastR=[],lastG=null;
    function _t(el,lim){var t=(el.textContent||'').replace(/\\s+/g,' ').trim();return lim&&t.length>lim?t.slice(0,lim)+'…':t}
    function _d(el){var d=0;while(el&&el!==document.body&&el!==document.documentElement){d++;el=el.parentElement}return d}
    function exec(cmd){
      cmd=cmd.trim();var m;
      if(cmd.includes(';')&&!cmd.startsWith(';'))return cmd.split(';').map(function(c){return c.trim()}).filter(Boolean).map(exec).join('\\n---\\n');
      if(cmd==='s')return 'p:outer c:'+lastR.length+' d:'+_d(cur)+' @'+(cur.tagName||'doc').toLowerCase();
      if(cmd==='t')return _t(cur);
      if((m=cmd.match(/^t(\\d+)$/)))return _t(cur,parseInt(m[1]));
      if(cmd.startsWith('q1 ')){try{var el=document.querySelector(cmd.slice(3).trim());if(!el)return '∅';cur=el;lastR=[el];return _t(el).slice(0,200)}catch(e){return '✗ '+e.message}}
      if(cmd.startsWith('q ')){try{var els=Array.from(document.querySelectorAll(cmd.slice(2).trim()));lastR=els;if(!els.length)return '∅';return els.slice(0,10).map(function(el,i){return '['+i+']'+_t(el).slice(0,60)}).join('\\n')}catch(e){return '✗ '+e.message}}
      if((m=cmd.match(/^n(\\d+)$/))){var idx=parseInt(m[1]);if(idx>=lastR.length)return '✗ out of range';cur=lastR[idx];return '✓ ['+idx+'] '+_t(cur).slice(0,100)}
      if(cmd==='up'){if(cur.parentElement)cur=cur.parentElement;return '✓ @'+(cur.tagName||'').toLowerCase()}
      if((m=cmd.match(/^up(\\d+)$/))){for(var i=0;i<parseInt(m[1]);i++)if(cur.parentElement)cur=cur.parentElement;return '✓ @'+(cur.tagName||'').toLowerCase()}
      if(cmd==='ch'){var ch=Array.from(cur.children);if(!ch.length)return '∅ no children';return ch.slice(0,15).map(function(c,i){var tag=c.tagName.toLowerCase();var cls=c.className?'.'+String(c.className).split(' ')[0]:'';return '['+i+']<'+tag+cls+'>'+_t(c).slice(0,30)}).join('\\n')}
      if(cmd.startsWith('g ')){var lines=(cur.textContent||'').split('\\n');var re=new RegExp(cmd.slice(2).trim(),'gi');var matches=[];lines.forEach(function(line,i){if(re.test(line)){var clean=line.replace(/\\s+/g,' ').trim();if(clean)matches.push('L'+(i+1)+': '+clean.slice(0,60))}});return matches.length?matches.slice(0,10).join('\\n'):'∅ no matches'}
      if(cmd==='look'){var inter=cur.querySelectorAll('a,button,input,select,textarea,[onclick],[href],.btn,[role=button]');var items=[];inter.forEach(function(el,idx){var text=(el.textContent||el.value||el.placeholder||el.getAttribute('title')||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().slice(0,20);if(text||el.tagName.toLowerCase()==='input')items.push({text:text||'['+(el.type||'input')+']',el:el,idx:idx})});lastG=items;if(!items.length)return '∅ no interactive elements';var out=items.length+' elements\\n';items.slice(0,20).forEach(function(item,i){var tag=item.el.tagName.toLowerCase();var href=item.el.getAttribute('href');out+='@'+i+' <'+tag+'> "'+item.text+'"'+(href?' →'+href.slice(0,25):'')+' \\n'});return out.trim()}
      if((m=cmd.match(/^@(\\d+)$/))){if(!lastG||parseInt(m[1])>=lastG.length)return '✗ call look first or index out of range';var it=lastG[parseInt(m[1])];try{it.el.click()}catch(e){}return '✓ clicked "'+it.text+'"'}
      if(cmd==='a'){if(!cur.attributes)return '∅';var attrs=[];for(var j=0;j<cur.attributes.length;j++){var at=cur.attributes[j];attrs.push(at.name+'='+at.value.slice(0,30))}return attrs.length?attrs.join(' '):'∅ no attrs'}
      if(cmd==='h')return cur.outerHTML;
      if((m=cmd.match(/^h(\\d+)$/))){var html=cur.outerHTML;var lim=parseInt(m[1]);return html.length>lim?html.slice(0,lim)+'…[truncated]':html}
      return '✗ unknown: '+cmd;
    }
    window.addEventListener('message',function(e){
      if(e.data&&e.data.type==='shiro-hc'){
        var result;try{result=exec(e.data.cmd)}catch(err){result='✗ '+err.message}
        e.source.postMessage({type:'shiro-hc-result',id:e.data.id,result:result},'*');
      }
    });
  })();
})();`;
}

/** Get the current subdomain (or null if on main domain) */
function getCurrentSubdomain(): string | null {
  if (typeof window === 'undefined') return null;
  const host = window.location.hostname;
  const match = host.match(/^([^.]+)\.shiro\.computer$/);
  return match ? match[1] : null;
}

/** Build the target URL for seeding */
function buildTargetUrl(targetSubdomain?: string): string {
  if (targetSubdomain) {
    return `https://${targetSubdomain}.shiro.computer/`;
  }
  // Default to current subdomain if on one, otherwise main domain
  const current = getCurrentSubdomain();
  if (current) {
    return `https://${current}.shiro.computer/`;
  }
  return 'https://shiro.computer/';
}

/**
 * Inline all external resources in the current document.
 * Replaces <script src> with <script>content</script>
 * Replaces <link rel="stylesheet" href> with <style>content</style>
 */
async function inlineDocument(): Promise<string> {
  // Clone the document
  const doc = document.cloneNode(true) as Document;
  const baseUrl = window.location.origin;

  // Find all external scripts
  const scripts = doc.querySelectorAll('script[src]');
  for (const script of scripts) {
    const src = script.getAttribute('src');
    if (!src) continue;

    try {
      const url = new URL(src, baseUrl).href;
      const res = await fetch(url);
      const content = await res.text();

      const inlineScript = doc.createElement('script');
      // Preserve type attribute (important for module scripts)
      const type = script.getAttribute('type');
      if (type) inlineScript.setAttribute('type', type);
      inlineScript.textContent = content;

      script.parentNode?.replaceChild(inlineScript, script);
    } catch (e) {
      console.warn(`Failed to inline script: ${src}`, e);
    }
  }

  // Find all external stylesheets
  const links = doc.querySelectorAll('link[rel="stylesheet"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;

    try {
      const url = new URL(href, baseUrl).href;
      const res = await fetch(url);
      const content = await res.text();

      const style = doc.createElement('style');
      style.textContent = content;

      link.parentNode?.replaceChild(style, link);
    } catch (e) {
      console.warn(`Failed to inline stylesheet: ${href}`, e);
    }
  }

  // Serialize the document
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

/**
 * Build a self-contained blob seed snippet.
 * The snippet decompresses and creates a blob URL for the iframe.
 */
function buildBlobSnippet(compressedB64: string, ndjson: string, storage: string, stats: SeedStats & { htmlSize: number; compressedSize: number }): string {
  const escapeForTemplate = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const escapedNdjson = escapeForTemplate(ndjson);
  const escapedStorage = escapeForTemplate(storage);

  const header = `// shiro blob seed v${stats.version} | ${stats.files} files | ${(stats.compressedSize / 1024).toFixed(0)}KB compressed`;

  // Minimal pako inflate (gunzip) - ~3KB minified
  const pakoInflate = `var pako=(function(){var Z=256,L=286,D=30,B=15,M=32768;function a(e){for(var t=new Uint16Array(16),n=0;n<16;n++)t[n]=0;for(n=0;n<e.length;n++)t[e[n]]++;t[0]=0;for(var r=new Uint16Array(16),i=0,n=1;n<16;n++)r[n]=i=i+t[n-1]<<1;var o=new Uint16Array(e.length);for(n=0;n<e.length;n++)e[n]&&(o[n]=r[e[n]]++);return{c:t,s:o}}function d(e,t,n){for(var r=new Uint16Array(n),i=0;i<n;i++)r[i]=0;for(i=0;i<e;i++)t[i]&&(r[t[i]]|=1<<B-t[i],r[t[i]]++);return r}function h(e,t){for(var n=0,r=0;r<t;r++)n=n<<1|e&1,e>>=1;return n}function u(e,t,n,r){for(var i=1<<n,o=0;o<i;o++){var s=h(o,n);if(s<e.length&&e[s]){var f=e[s]>>>4,c=e[s]&15;t[o]=f<<8|c}}}function f(e,t){var n=new Uint8Array(320);for(var r=0;r<144;r++)n[r]=8;for(;r<256;r++)n[r]=9;for(;r<280;r++)n[r]=7;for(;r<288;r++)n[r]=8;var i=a(n),o=new Uint16Array(512);u(i.s.subarray(0,288),o,9,288);var s=new Uint8Array(32);for(r=0;r<32;r++)s[r]=5;var c=a(s),l=new Uint16Array(32);u(c.s,l,5,32);return{lit:o,dst:l}}function g(e,t,n,r,i,o){var s=0,c=0,l=0,p=0,v=0,b=0,y=0,w=0,k=f(),x=k.lit,E=k.dst,T=new Uint8Array(M),A=0;while(1){if(l<3){s|=e[n++]<<l;l+=8}var C=s&7;s>>>=3;l-=3;if(C&1)break;if((C&6)===0){if(l<32){s|=e[n++]<<l;l+=8;s|=e[n++]<<l;l+=8;s|=e[n++]<<l;l+=8;s|=e[n++]<<l;l+=8}var S=s&65535;s>>>=16;l-=16;var O=s&65535;s>>>=16;l-=16;for(var j=0;j<S;j++)T[A++]=e[n++];continue}while(1){while(l<15){s|=e[n++]<<l;l+=8}var R=x[s&511];if(!R){s>>>=9;l-=9;continue}var _=R&15,N=R>>>8;s>>>=_;l-=_;if(N<256){T[A++]=N}else if(N===256){break}else{var I=N-257,P=0;if(I<8)P=I;else{while(l<5){s|=e[n++]<<l;l+=8}P=(I-8<<5)+(s&31)+8;s>>>=5;l-=5}var F=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258][I],q=F+P;while(l<15){s|=e[n++]<<l;l+=8}var z=E[s&31];if(!z)continue;var W=z&15,H=z>>>8;s>>>=W;l-=W;var V=0;if(H<4)V=H;else{while(l<13){s|=e[n++]<<l;l+=8}V=(H-4<<13)+(s&8191)+4;s>>>=13;l-=13}var G=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577][H],Y=G+V;for(var X=0;X<q;X++)T[A++]=T[A-Y]}}}}return T.subarray(0,A)}return{inflate:g}})();`;

  return `${header}
(function(){
  if(document.getElementById('shiro-seed')){console.log('Shiro already seeded');return}
  ${pakoInflate}
  var b64='${compressedB64}';
  var bin=atob(b64);var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
  var html=new TextDecoder().decode(pako.inflate(u8.subarray(10)));
  var blob=new Blob([html],{type:'text/html'});
  var blobUrl=URL.createObjectURL(blob);
  var w=document.createElement('div');w.id='shiro-seed';
  var S=w.style;S.position='fixed';S.bottom='20px';S.right='20px';S.width='32em';S.height='22em';
  S.zIndex='2147483647';S.borderRadius='8px';S.overflow='hidden';
  S.boxShadow='rgb(206,170,227) 0px 5px 11px -3px';S.opacity='0.88';S.backdropFilter='blur(8px)';
  S.fontFamily='-apple-system,BlinkMacSystemFont,sans-serif';S.display='flex';S.flexDirection='column';
  var tb=document.createElement('div');
  var T=tb.style;T.background='#1a1a2e';T.height='32px';T.display='flex';T.alignItems='center';
  T.padding='0 10px';T.cursor='grab';T.userSelect='none';T.flexShrink='0';
  var dots=document.createElement('div');dots.style.display='flex';dots.style.gap='6px';
  var close=document.createElement('div');var cs=close.style;
  cs.width='12px';cs.height='12px';cs.borderRadius='50%';cs.background='#ff5f57';cs.cursor='pointer';
  close.onclick=function(){URL.revokeObjectURL(blobUrl);w.remove()};
  var mini=document.createElement('div');var ms=mini.style;
  ms.width='12px';ms.height='12px';ms.borderRadius='50%';ms.background='#febc2e';ms.cursor='pointer';
  var minimized=false;
  mini.onclick=function(){
    minimized=!minimized;
    iframe.style.display=minimized?'none':'block';
    rh.style.display=minimized?'none':'block';
    w.style.height=minimized?'32px':savedH+'px';
  };
  dots.appendChild(close);dots.appendChild(mini);
  var title=document.createElement('span');title.textContent='shiro';
  var ts=title.style;ts.color='#8888cc';ts.fontSize='13px';ts.fontWeight='600';ts.marginLeft='10px';ts.flex='1';
  var fontSize=14;
  var zoomWrap=document.createElement('div');zoomWrap.style.cssText='display:flex;gap:4px;opacity:0;transition:opacity 0.15s';
  var zoomOut=document.createElement('div');zoomOut.textContent='−';
  zoomOut.style.cssText='width:14px;height:14px;border-radius:50%;background:#555;color:#fff;font-size:12px;line-height:14px;text-align:center;cursor:pointer';
  var zoomIn=document.createElement('div');zoomIn.textContent='+';
  zoomIn.style.cssText='width:14px;height:14px;border-radius:50%;background:#555;color:#fff;font-size:12px;line-height:14px;text-align:center;cursor:pointer';
  zoomOut.onclick=function(e){e.stopPropagation();fontSize=Math.max(8,fontSize-1);iframe.contentWindow.postMessage({type:'shiro-fontsize',size:fontSize},'*')};
  zoomIn.onclick=function(e){e.stopPropagation();fontSize=Math.min(24,fontSize+1);iframe.contentWindow.postMessage({type:'shiro-fontsize',size:fontSize},'*')};
  zoomWrap.appendChild(zoomOut);zoomWrap.appendChild(zoomIn);
  tb.onmouseenter=function(){zoomWrap.style.opacity='1'};
  tb.onmouseleave=function(){zoomWrap.style.opacity='0'};
  tb.appendChild(dots);tb.appendChild(title);tb.appendChild(zoomWrap);
  var iframe=document.createElement('iframe');iframe.src=blobUrl;
  var is=iframe.style;is.border='none';is.width='100%';is.flex='1';is.background='#0a0a1a';
  iframe.allow='clipboard-read; clipboard-write';
  iframe.sandbox='allow-scripts allow-same-origin allow-forms allow-modals allow-popups';
  var rh=document.createElement('div');var rs=rh.style;
  rs.position='absolute';rs.bottom='0';rs.right='0';rs.width='16px';rs.height='16px';
  rs.cursor='nwse-resize';rs.background='linear-gradient(135deg,transparent 50%,#555 50%)';
  w.appendChild(tb);w.appendChild(iframe);w.appendChild(rh);
  document.body.appendChild(w);
  var dx=0,dy=0,sx=0,sy=0,dragging=false;
  tb.onmousedown=function(e){dragging=true;sx=e.clientX;sy=e.clientY;
    var r=w.getBoundingClientRect();dx=r.left;dy=r.top;
    tb.style.cursor='grabbing';e.preventDefault()};
  document.addEventListener('mousemove',function(e){
    if(dragging){w.style.left=(dx+e.clientX-sx)+'px';w.style.top=(dy+e.clientY-sy)+'px';
      w.style.right='auto';w.style.bottom='auto'}
    if(resizing){var rr=w.getBoundingClientRect();
      var nw=Math.max(300,e.clientX-rr.left);var nh=Math.max(200,e.clientY-rr.top);
      w.style.width=nw+'px';w.style.height=nh+'px';savedH=nh}});
  document.addEventListener('mouseup',function(){dragging=false;resizing=false;tb.style.cursor='grab'});
  var resizing=false,savedH=w.offsetHeight||352;
  rh.onmousedown=function(e){resizing=true;e.preventDefault();e.stopPropagation()};
  var SEED_FS=\`${escapedNdjson}\`;
  var SEED_STORAGE=\`${escapedStorage}\`;
  var seeded=false;
  iframe.onload=function(){
    if(seeded)return;seeded=true;
    iframe.contentWindow.postMessage({type:'shiro-seed-v2',ndjson:SEED_FS,storage:SEED_STORAGE},'*');
  };
  (function(){
    var cur=document.body,lastR=[],lastG=null;
    function _t(el,lim){var t=(el.textContent||'').replace(/\\s+/g,' ').trim();return lim&&t.length>lim?t.slice(0,lim)+'…':t}
    function _d(el){var d=0;while(el&&el!==document.body&&el!==document.documentElement){d++;el=el.parentElement}return d}
    function exec(cmd){
      cmd=cmd.trim();var m;
      if(cmd.includes(';')&&!cmd.startsWith(';'))return cmd.split(';').map(function(c){return c.trim()}).filter(Boolean).map(exec).join('\\n---\\n');
      if(cmd==='s')return 'p:outer c:'+lastR.length+' d:'+_d(cur)+' @'+(cur.tagName||'doc').toLowerCase();
      if(cmd==='t')return _t(cur);
      if((m=cmd.match(/^t(\\d+)$/)))return _t(cur,parseInt(m[1]));
      if(cmd.startsWith('q1 ')){try{var el=document.querySelector(cmd.slice(3).trim());if(!el)return '∅';cur=el;lastR=[el];return _t(el).slice(0,200)}catch(e){return '✗ '+e.message}}
      if(cmd.startsWith('q ')){try{var els=Array.from(document.querySelectorAll(cmd.slice(2).trim()));lastR=els;if(!els.length)return '∅';return els.slice(0,10).map(function(el,i){return '['+i+']'+_t(el).slice(0,60)}).join('\\n')}catch(e){return '✗ '+e.message}}
      if((m=cmd.match(/^n(\\d+)$/))){var idx=parseInt(m[1]);if(idx>=lastR.length)return '✗ out of range';cur=lastR[idx];return '✓ ['+idx+'] '+_t(cur).slice(0,100)}
      if(cmd==='up'){if(cur.parentElement)cur=cur.parentElement;return '✓ @'+(cur.tagName||'').toLowerCase()}
      if((m=cmd.match(/^up(\\d+)$/))){for(var i=0;i<parseInt(m[1]);i++)if(cur.parentElement)cur=cur.parentElement;return '✓ @'+(cur.tagName||'').toLowerCase()}
      if(cmd==='ch'){var ch=Array.from(cur.children);if(!ch.length)return '∅ no children';return ch.slice(0,15).map(function(c,i){var tag=c.tagName.toLowerCase();var cls=c.className?'.'+String(c.className).split(' ')[0]:'';return '['+i+']<'+tag+cls+'>'+_t(c).slice(0,30)}).join('\\n')}
      if(cmd.startsWith('g ')){var lines=(cur.textContent||'').split('\\n');var re=new RegExp(cmd.slice(2).trim(),'gi');var matches=[];lines.forEach(function(line,i){if(re.test(line)){var clean=line.replace(/\\s+/g,' ').trim();if(clean)matches.push('L'+(i+1)+': '+clean.slice(0,60))}});return matches.length?matches.slice(0,10).join('\\n'):'∅ no matches'}
      if(cmd==='look'){var inter=cur.querySelectorAll('a,button,input,select,textarea,[onclick],[href],.btn,[role=button]');var items=[];inter.forEach(function(el,idx){var text=(el.textContent||el.value||el.placeholder||el.getAttribute('title')||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().slice(0,20);if(text||el.tagName.toLowerCase()==='input')items.push({text:text||'['+(el.type||'input')+']',el:el,idx:idx})});lastG=items;if(!items.length)return '∅ no interactive elements';var out=items.length+' elements\\n';items.slice(0,20).forEach(function(item,i){var tag=item.el.tagName.toLowerCase();var href=item.el.getAttribute('href');out+='@'+i+' <'+tag+'> "'+item.text+'"'+(href?' →'+href.slice(0,25):'')+' \\n'});return out.trim()}
      if((m=cmd.match(/^@(\\d+)$/))){if(!lastG||parseInt(m[1])>=lastG.length)return '✗ call look first or index out of range';var it=lastG[parseInt(m[1])];try{it.el.click()}catch(e){}return '✓ clicked "'+it.text+'"'}
      if(cmd==='a'){if(!cur.attributes)return '∅';var attrs=[];for(var j=0;j<cur.attributes.length;j++){var at=cur.attributes[j];attrs.push(at.name+'='+at.value.slice(0,30))}return attrs.length?attrs.join(' '):'∅ no attrs'}
      if(cmd==='h')return cur.outerHTML;
      if((m=cmd.match(/^h(\\d+)$/))){var html=cur.outerHTML;var lim=parseInt(m[1]);return html.length>lim?html.slice(0,lim)+'…[truncated]':html}
      return '✗ unknown: '+cmd;
    }
    window.addEventListener('message',function(e){
      if(e.data&&e.data.type==='shiro-hc'){
        var result;try{result=exec(e.data.cmd)}catch(err){result='✗ '+err.message}
        e.source.postMessage({type:'shiro-hc-result',id:e.data.id,result:result},'*');
      }
    });
  })();
})();`;
}

export const seedCmd: Command = {
  name: 'seed',
  description: 'Copy Shiro seed to clipboard (seed [blob] [subdomain])',

  async exec(ctx: CommandContext): Promise<number> {
    // Check for blob mode: seed blob
    const isBlob = ctx.args[0] === 'blob';
    const targetArg = isBlob ? ctx.args[1] : ctx.args[0];
    const url = buildTargetUrl(targetArg);

    try {
      // For blob mode, we need to inline the document and compress it
      let compressedB64 = '';
      let htmlSize = 0;
      let compressedSize = 0;

      if (isBlob) {
        ctx.stdout = 'Inlining document resources...\n';

        // Inline all external resources
        const inlinedHtml = await inlineDocument();
        htmlSize = inlinedHtml.length;

        ctx.stdout += `  HTML size: ${(htmlSize / 1024).toFixed(0)} KB\n`;
        ctx.stdout += 'Compressing...\n';

        // Compress with gzip
        const encoder = new TextEncoder();
        const htmlBytes = encoder.encode(inlinedHtml);

        // Use CompressionStream API (available in modern browsers)
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(htmlBytes);
        writer.close();

        const compressedChunks: Uint8Array[] = [];
        const reader = cs.readable.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          compressedChunks.push(value);
        }

        // Concatenate chunks
        const totalLength = compressedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const compressed = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of compressedChunks) {
          compressed.set(chunk, offset);
          offset += chunk.length;
        }

        compressedSize = compressed.length;
        compressedB64 = uint8ToBase64(compressed);

        ctx.stdout += `  Compressed: ${(compressedSize / 1024).toFixed(0)} KB (${((1 - compressedSize / htmlSize) * 100).toFixed(0)}% reduction)\n`;
      }

      // Export filesystem
      const nodes = await ctx.fs.exportAll();

      // Calculate stats
      let fileCount = 0;
      let dirCount = 0;
      let totalBytes = 0;

      // Build NDJSON - one JSON object per line
      const ndjsonLines: string[] = [];
      for (const node of nodes) {
        if (node.type === 'file') {
          fileCount++;
          totalBytes += node.size || 0;
        } else if (node.type === 'dir') {
          dirCount++;
        }

        const serialized = {
          path: node.path,
          type: node.type,
          content: node.content ? uint8ToBase64(node.content) : null,
          mode: node.mode,
          mtime: node.mtime,
          ctime: node.ctime,
          size: node.size,
          symlinkTarget: node.symlinkTarget,
        };
        ndjsonLines.push(JSON.stringify(serialized));
      }
      const ndjson = ndjsonLines.join('\n');

      // Export localStorage
      const storage: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        storage[key] = localStorage.getItem(key)!;
      }
      const storageJson = JSON.stringify(storage);

      // Detect API keys
      const detectedKeys = detectApiKeys(storage);

      // Build stats
      const stats: SeedStats = {
        version: SHIRO_VERSION,
        files: fileCount,
        dirs: dirCount,
        totalBytes,
        sizeKB: Math.round(totalBytes / 1024),
        sizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
        detectedKeys,
      };

      // Build the appropriate snippet
      const snippet = isBlob
        ? buildBlobSnippet(compressedB64, ndjson, storageJson, { ...stats, htmlSize, compressedSize })
        : buildSnippet(url, ndjson, storageJson, stats);

      const snippetSizeKBNum = snippet.length / 1024;
      const snippetSizeKB = snippetSizeKBNum.toFixed(0);
      const snippetSizeMB = (snippet.length / (1024 * 1024)).toFixed(2);

      await navigator.clipboard.writeText(snippet);

      // Build output with stats
      let output = '\n';
      output += `  Shiro ${isBlob ? 'Blob ' : ''}Seed v${SHIRO_VERSION}\n`;
      output += `  ${'─'.repeat(30)}\n`;
      if (isBlob) {
        output += `  Mode:        self-contained blob (CSP-safe)\n`;
        output += `  HTML size:   ${(htmlSize / 1024).toFixed(0)} KB\n`;
        output += `  Compressed:  ${(compressedSize / 1024).toFixed(0)} KB\n`;
      } else {
        output += `  Target:      ${url}\n`;
      }
      output += `  Files:       ${fileCount}\n`;
      output += `  Directories: ${dirCount}\n`;
      output += `  Data size:   ${stats.sizeMB} MB\n`;
      output += `  Seed size:   ${snippetSizeMB} MB (${snippetSizeKB} KB)\n`;

      if (detectedKeys.length > 0) {
        output += `\n  API keys detected:\n`;
        for (const key of detectedKeys) {
          output += `    - ${key}\n`;
        }
      }

      // Size warning for large seeds
      if (snippetSizeKBNum > 10000) {
        output += `\n  Warning: Large seed may crash low-memory devices.\n`;
        output += `  Consider: rm -rf node_modules && seed\n`;
      }

      output += `\n  Copied. Open DevTools (F12 or Cmd+Opt+J) → Console → Paste.\n\n`;

      ctx.stdout = output;
      return 0;
    } catch (e: any) {
      ctx.stderr = `seed: ${e.message}\n`;
      return 1;
    }
  },
};
