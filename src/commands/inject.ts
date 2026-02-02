import { Command, CommandContext } from './index';

/**
 * seed: Copy a Shiro seed to clipboard — full state snapshot
 *
 * Serializes the entire IndexedDB filesystem + localStorage into a
 * self-contained snippet. When pasted into any browser's DevTools console,
 * it creates a floating Shiro iframe and hydrates it with the captured state.
 */

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function buildSnippet(url: string, seedJson: string): string {
  // Escape the seed JSON for embedding as a JS string literal
  const escapedSeed = JSON.stringify(seedJson);
  return `(function(){
  if(document.getElementById('shiro-seed')){console.log('Shiro already seeded');return}
  var w=document.createElement('div');w.id='shiro-seed';
  var S=w.style;S.position='fixed';S.bottom='20px';S.right='20px';S.width='700px';S.height='500px';
  S.zIndex='2147483647';S.borderRadius='8px';S.overflow='hidden';S.boxShadow='0 8px 32px rgba(0,0,0,0.4)';
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
  var ts=title.style;ts.color='#8888cc';ts.fontSize='13px';ts.fontWeight='600';ts.marginLeft='10px';
  tb.appendChild(dots);tb.appendChild(title);
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
  var resizing=false,savedH=500;
  rh.onmousedown=function(e){resizing=true;e.preventDefault();e.stopPropagation()};
  /* Seed: send state to Shiro iframe after it loads */
  var SEED=JSON.parse(${escapedSeed});
  var seeded=false;
  iframe.onload=function(){
    if(!seeded){seeded=true;iframe.contentWindow.postMessage({type:'shiro-seed',data:SEED},'*')}
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

export const seedCmd: Command = {
  name: 'seed',
  description: 'Copy Shiro seed to clipboard (full state snapshot)',

  async exec(ctx: CommandContext): Promise<number> {
    const url = 'https://shiro.computer/';

    try {
      // Export filesystem
      const nodes = await ctx.fs.exportAll();
      const serializedNodes = nodes.map(node => ({
        path: node.path,
        type: node.type,
        content: node.content ? uint8ToBase64(node.content) : null,
        mode: node.mode,
        mtime: node.mtime,
        ctime: node.ctime,
        size: node.size,
        symlinkTarget: node.symlinkTarget,
      }));

      // Export localStorage
      const storage: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        storage[key] = localStorage.getItem(key)!;
      }

      const seedData = JSON.stringify({ fs: serializedNodes, localStorage: storage });
      const snippet = buildSnippet(url, seedData);
      const sizeKB = (snippet.length / 1024).toFixed(0);

      await navigator.clipboard.writeText(snippet);
      ctx.stdout = `Seed copied (${nodes.length} files, ${sizeKB}KB). Paste into any browser console.\n`;
      return 0;
    } catch (e: any) {
      ctx.stderr = `seed: ${e.message}\n`;
      return 1;
    }
  },
};
