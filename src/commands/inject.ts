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

export const seedCmd: Command = {
  name: 'seed',
  description: 'Copy Shiro seed to clipboard (seed [subdomain])',

  async exec(ctx: CommandContext): Promise<number> {
    // Parse optional subdomain argument: seed dev → dev.shiro.computer
    const targetArg = ctx.args[0];
    const url = buildTargetUrl(targetArg);

    try {
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

      const snippet = buildSnippet(url, ndjson, storageJson, stats);
      const snippetSizeKBNum = snippet.length / 1024;
      const snippetSizeKB = snippetSizeKBNum.toFixed(0);
      const snippetSizeMB = (snippet.length / (1024 * 1024)).toFixed(2);

      await navigator.clipboard.writeText(snippet);

      // Build output with stats
      let output = '\n';
      output += `  Shiro Seed v${SHIRO_VERSION}\n`;
      output += `  ${'─'.repeat(30)}\n`;
      output += `  Target:      ${url}\n`;
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
