// @dsh-android/dsh-host-web-compat
// 1) 通过 webServer.tapIndex 在每次 index 响应注入缺失的浏览器 API polyfill。
// 2) Android 目录选择桥：把 ctx.directoryPicker（native capability）接到壳 APK 的
//    WebView JS 桥（window.androidBridge.pickDirectory → SAF 选择器 → 真实路径）。
//    页面侧轮询 /api/android/dir-pick/poll 领取请求，选择完成后 POST 结果回引擎。
//    外部工作区（/storage/emulated/0/...）需要 All Files Access；壳 APK 侧负责引导。

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'

/** 每个缺失 API 的 polyfill 片段（幂等：已存在则跳过）。 */
const POLYFILLS = [
  // AbortSignal.any: Chrome 116+/Node 20.3+；老 WebView 无
  `if(typeof AbortSignal!=='undefined'&&!AbortSignal.any){AbortSignal.any=function(s){var c=new AbortController(),f=function(){c.abort()};for(var i=0;i<s.length;i++){if(s[i].aborted){c.abort();return c.signal}s[i].addEventListener('abort',f,{once:true})}return c.signal}}`,
  // structuredClone: Chrome 98+/Node 17+；更老的 WebView 无
  `if(typeof structuredClone==='undefined'){structuredClone=function(v){return JSON.parse(JSON.stringify(v))}}`,
];

/** 页面侧：目录选择桥 + 权限提示回调（幂等注入）。 */
const PICKER_SCRIPT = `<script>(function(){
if(window.__dshBridge){return}
window.__dshBridge={
onDirectoryPicked:function(callbackId,path){
try{var h={'content-type':'application/json'};if(window.androidBridge&&window.androidBridge.getPickToken){h['x-dsh-pick-token']=window.androidBridge.getPickToken()}fetch('/api/android/dir-pick/result',{method:'POST',headers:h,body:JSON.stringify({requestId:callbackId,path:path})})}catch(e){}
},
onPermissionRequired:function(){
try{alert('需要\u201c所有文件访问\u201d权限才能使用外部目录。请在系统设置中允许后重试。')}catch(e){}
}
};
var requestedIds={};
function pickHeaders(){
var h={};
if(window.androidBridge&&window.androidBridge.getPickToken){h['x-dsh-pick-token']=window.androidBridge.getPickToken()}
return h;
}
function poll(){
try{fetch('/api/android/dir-pick/poll',{headers:pickHeaders()}).then(function(r){return r.json()}).then(function(j){
if(j&&j.requestId&&window.androidBridge&&!requestedIds[j.requestId]){
requestedIds[j.requestId]=true;window.androidBridge.pickDirectory(j.requestId)
}
}).catch(function(){}).then(function(){setTimeout(poll,500)})}catch(e){setTimeout(poll,500)}
}
poll()
})();
(function(){
if(window.__dshFilePick){return}
window.__dshFilePick=true;
var added=false;
function ensureItem(){
var menu=document.querySelector('[role=listbox]');
if(!menu||added)return;
added=true;
var item=document.createElement('button');
item.type='button';
item.setAttribute('data-dsh-file-pick','1');
item.textContent='选择文件';
item.style.cssText='display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#333);text-align:left';
item.onclick=function(){
var input=document.createElement('input');
input.type='file';
input.accept='image/*';
input.multiple=true;
input.style.display='none';
document.body.appendChild(input);
input.onchange=function(){
var files=input.files;
input.remove();
if(!files||files.length===0)return;
try{
var dt=new DataTransfer();
for(var i=0;i<files.length;i++){dt.items.add(files[i])}
document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt}));
}catch(e){console.error('dsh file pick drop failed',e)}
};
input.click();
};
menu.appendChild(item);
}
function start(){
var obs=new MutationObserver(function(){
var menu=document.querySelector('[role=listbox]');
if(menu&&!menu.querySelector('[data-dsh-file-pick]')){
added=false;ensureItem();
}
});
obs.observe(document.body,{childList:true,subtree:true});
}
if(document.body){start()}else{document.addEventListener('DOMContentLoaded',start)}
})()</scr` + `ipt>`;

const POLYFILL_SCRIPT =
  '<script>' + POLYFILLS.join('') + '</scr' + 'ipt>' + PICKER_SCRIPT;

/**
 * Android directory-picker backend: kind 'native'. pick() waits for the
 * WebView page (polling the engine) to run the SAF chooser and POST the
 * real path back; abort cancels the pending request.
 */
class AndroidDirectoryPicker extends Service {
  constructor(ctx) {
    super(ctx, 'directoryPicker')
    this.pending = new Map() // requestId -> {resolve, signal}
  }

  capability() {
    const self = this
    return {
      kind: 'native',
      pick(signal) {
        return self.pick(signal)
      },
    }
  }

  pick(signal) {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('directory pick aborted'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, signal })
      const settle = (fn, reason) => {
        this.pending.delete(requestId)
        clearTimeout(ttl)
        signal.removeEventListener('abort', onAbort)
        fn(reason)
      }
      const onAbort = () => settle(reject, signal.reason ?? new Error('directory pick aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      // TTL：页面刷新/导航离开/引擎重启后无人领取时，防止 pending 永久挂起。
      const ttl = setTimeout(() => settle(reject, new Error('directory pick timed out')), 5 * 60 * 1000)
      // 结算后清理定时器与监听（长生命周期 signal 上监听泄漏）。
      const entry = this.pending.get(requestId)
      const origResolve = entry.resolve
      entry.resolve = (path) => {
        clearTimeout(ttl)
        signal.removeEventListener('abort', onAbort)
        origResolve(path)
      }
    })
  }

  takePoll() {
    // One-shot delivery: the page polls every 500ms; returning the same id
    // twice would re-launch the SAF chooser per poll (observed: picker
    // stacking). A request is handed out exactly once and re-armed only by
    // the next pick().
    for (const [id, entry] of this.pending) {
      if (entry.delivered) continue
      entry.delivered = true
      return id
    }
    return null
  }

  resolve(requestId, path) {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    entry.resolve(path)
    return true
  }
}

export const name = 'host-web-compat';
export const inject = ['webServer'];

export function apply(ctx) {
  // Polyfills + picker bridge script into every index response.
  ctx.webServer.tapIndex((html) =>
    html.includes('AbortSignal.any') ? html : html.replace('</head>', POLYFILL_SCRIPT + '</head>')
  );

  // Android directory-picker backend: registered as ctx.directoryPicker.
  // 端点鉴权：壳 APK 每次启动生成 DSH_PICK_TOKEN（引擎 env），页面 JS 经
  // androidBridge.getPickToken() 取同一 token 并带 x-dsh-pick-token 头；
  // 本机其他进程/页面无 token，无法轮询或伪造目录选择结果。
  const picker = new AndroidDirectoryPicker(ctx);
  const token = process.env.DSH_PICK_TOKEN || '';
  const authorized = (req) => token === '' || req.headers['x-dsh-pick-token'] === token;
  const disposePoll = ctx.webServer.register({
    kind: 'exact',
    path: '/api/android/dir-pick/poll',
    handler: (req, res) => {
      if (!authorized(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ requestId: picker.takePoll() }))
    },
  });
  const disposeResult = ctx.webServer.register({
    kind: 'exact',
    path: '/api/android/dir-pick/result',
    handler: (req, res) => {
      if (!authorized(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      let body = ''
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) { req.destroy(); return } // 回环恶意客户端上限
        body += chunk
      })
      req.on('end', () => {
        try {
          const { requestId, path } = JSON.parse(body)
          picker.resolve(requestId, path ?? null)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        } catch {
          res.writeHead(400)
          res.end('bad json')
        }
      })
    },
  });
  ctx.effect(() => () => {
    disposePoll()
    disposeResult()
  });
}
