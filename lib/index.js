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
  // AbortSignal.timeout: Chrome 103+/Node 17.3+；Android 12 时代的 WebView（Chromium<103）无
  `if(typeof AbortSignal!=='undefined'&&!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){try{c.abort(new DOMException('TimeoutError','TimeoutError'))}catch(e){c.abort()}},ms);return c.signal}}`,
  // structuredClone: Chrome 98+/Node 17+；更老的 WebView 无
  `if(typeof structuredClone==='undefined'){structuredClone=function(v){return JSON.parse(JSON.stringify(v))}}`,
];

// 启动看门狗（2026-08-17，issue #36）：页面停留在「Loading plugins…」超过 40s 时，
// 采集诊断（manifest 条目、/plugins/ bundle 资源状态、引擎 HTTP 可达性）并显示，
// 且每个会话自动重载一次。把「永远转圈且无信息」的单点卡死变成「自愈 + 可反馈」。
const BOOT_WATCHDOG_SCRIPT = `<script>(function(){
if(window.__dshBootDiag){return}window.__dshBootDiag=true;
var reloaded=false;
try{reloaded=!!sessionStorage.getItem('dshBootReloaded')}catch(e){}
function pendingBoot(){
  try{return /Loading plugins/i.test(document.body.textContent||'')}catch(e){return false}
}
function collect(){
  var r={tookMs:0,ua:(navigator.userAgent||'').slice(0,180),manifest:null,bundleCount:0,pendingBundles:[],badBundles:[],engineHttp:null};
  try{var b=window.__DSH_BOOT__;r.manifest=b?{rev:b.rev,count:(b.entries||[]).length,ids:(b.entries||[]).map(function(e){return e.id})}:null}catch(e){r.manifest='ERR '+e}
  try{
    var res=window.performance&&performance.getEntriesByType?performance.getEntriesByType('resource'):[];
    var pl=res.filter(function(x){return x.name.indexOf('/plugins/')>=0});
    r.bundleCount=pl.length;
    r.pendingBundles=pl.filter(function(x){return (x.duration===0&&x.responseEnd===0)||x.responseStart===0}).map(function(x){return x.name});
    r.badBundles=pl.filter(function(x){return x.responseStatus>=400}).map(function(x){return x.name+' #'+x.responseStatus});
  }catch(e){r.perfErr=String(e)}
  return r;
}
function show(report){
  try{
    var d=document.createElement('div');d.id='dsh-boot-diag';
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.97);color:#d7d7d7;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;padding:16px;overflow:auto;white-space:pre-wrap';
    d.textContent='[dsh] 启动停留在 loading plugins（'+report.tookMs+'ms）\n'+JSON.stringify(report,null,2)+'\n\n请截图本屏，或 设置→开发者选项→导出调试日志 反馈维护方。';
    var b=document.createElement('button');b.textContent='重试加载';b.style.cssText='display:block;margin:14px auto 0;padding:8px 16px;border:1px solid #999;border-radius:8px;background:#222;color:#fff;font-size:13px;cursor:pointer';
    b.onclick=function(){try{location.reload()}catch(e){}};
    d.appendChild(b);document.body.appendChild(d);
  }catch(e){}
}
async function run(){
  var t0=Date.now();
  for(var i=0;i<20;i++){
    await new Promise(function(r){setTimeout(r,2000)});
    if(!pendingBoot())return;
  }
  if(!pendingBoot())return;
  var report=collect();report.tookMs=Date.now()-t0;
  var ac=new AbortController();var timer=setTimeout(function(){ac.abort()},3000);
  try{var res=await fetch(location.href,{method:'HEAD',cache:'no-store',signal:ac.signal});report.engineHttp=res.status}catch(e){report.engineHttp='ERR'}finally{clearTimeout(timer)}
  try{console.error('[dsh-boot-stall]',report)}catch(e){}
  show(report);
  if(!reloaded){reloaded=true;try{sessionStorage.setItem('dshBootReloaded','1')}catch(e){}
    setTimeout(function(){try{location.reload()}catch(e){}},9000)
  }
}
if(document.body){run()}else{document.addEventListener('DOMContentLoaded',run)}
})()</script>`;

// 主题桥：部分厂商 WebView（vivo/Android 16 实测）的 prefers-color-scheme 不跟随
// 系统 uiMode——必须在任何上游 matchMedia 查询（ui-theme 插件）之前 hook，
// 由壳 APK 经 window.__dshThemeBridge.setDark() 推送系统深色状态。
// 幂等：已存在则跳过；纯前端注入，零上游改动。
const THEME_BRIDGE_SCRIPT = `<script>(function(){
if(window.__dshThemeBridge){return}
var dark=false,listeners=[]
var native=window.matchMedia.bind(window)
window.matchMedia=function(q){
  if(q.indexOf('prefers-color-scheme')<0)return native(q)
  var fire=function(){for(var i=0;i<listeners.length;i++){try{listeners[i]()}catch(e){}}}
  return {
    get matches(){return dark}, get media(){return q}, onchange:null,
    addEventListener:function(t,cb){if(t==='change'&&typeof cb==='function'){listeners.push(cb);fire()}},
    removeEventListener:function(t,cb){var i=listeners.indexOf(cb);if(i>=0)listeners.splice(i,1)},
    addListener:function(cb){listeners.push(cb)},removeListener:function(cb){var i=listeners.indexOf(cb);if(i>=0)listeners.splice(i,1)},
    dispatchEvent:function(){return false}
  }
}
window.__dshThemeBridge={setDark:function(d){if(dark===d)return;dark=d;for(var i=0;i<listeners.length;i++){try{listeners[i]()}catch(e){}}}}
try{
// H1（2026-08-16）：首帧同步拉取真实 uiMode——厂商 WebView 的 matchMedia
// 卡 light（vivo/Android 16）时，boot-theme 与上游 ui-theme 首帧都会拿到
// 浅色；壳的 getSystemDark() 是同步 JS 桥，注入后立即得到真实深色，
// 白闪首帧消除（不再依赖 onPageFinished 推送的异步时序）。
var sysDark=false;
if(window.androidBridge&&window.androidBridge.getSystemDark){sysDark=!!window.androidBridge.getSystemDark()}
else{try{sysDark=!!native('(prefers-color-scheme: dark)').matches}catch(e){}}
if(sysDark)window.__dshThemeBridge.setDark(true)
}catch(e){}
})()</script>`;

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
var imgAdded=false;
function ensureItem(){
var menu=document.querySelector('[role=listbox]');
if(!menu||added)return;
added=true;
var item=document.createElement('button');
item.type='button';
item.setAttribute('data-dsh-file-pick','1');
item.textContent='上传文件';
item.style.cssText='display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#333);text-align:left';
item.onclick=function(){
var input=document.createElement('input');
input.type='file';
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
var item2=document.createElement('button');
item2.type='button';
item2.setAttribute('data-dsh-debug-log','1');
item2.textContent='导出调试日志';
item2.style.cssText='display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#333);text-align:left';
item2.onclick=function(){
try{if(window.androidBridge&&window.androidBridge.downloadDebugLogs){window.androidBridge.downloadDebugLogs()}}catch(e){console.error('dsh debug log export failed',e)}
};
menu.appendChild(item2);
}
function ensureImageItem(){
var menu=document.querySelector('[role=listbox]');
if(!menu||imgAdded)return;
if(!menu.querySelector('[data-dsh-image-pick]')){
var item3=document.createElement('button');
item3.type='button';
item3.setAttribute('data-dsh-image-pick','1');
item3.textContent='上传图片';
item3.style.cssText='display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#333);text-align:left';
item3.onclick=function(){
try{
if(window.androidBridge&&window.androidBridge.pickImage){var cb='dshimg'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);window.androidBridge.pickImage(cb)}
else{alert('当前宿主不支持图片选择')}
}catch(e){console.error('dsh image pick failed',e)}
};
menu.appendChild(item3);
}
imgAdded=true;
}
function start(){
try{
if(!document.getElementById('dsh-menu-style')){
var st=document.createElement('style');st.id='dsh-menu-style';
st.textContent='[aria-label="添加图片"]{display:none!important;}[role="listbox"],[role="menu"]{max-width:min(92vw,340px)!important;}';
document.head.appendChild(st);
}
}catch(e){}
var obs=new MutationObserver(function(){
var menu=document.querySelector('[role=listbox]');
if(menu&&!menu.querySelector('[data-dsh-file-pick]')){
added=false;ensureItem();
}
if(menu&&!menu.querySelector('[data-dsh-image-pick]')){
imgAdded=false;ensureImageItem();
}
});
obs.observe(document.body,{childList:true,subtree:true});
}
if(document.body){start()}else{document.addEventListener('DOMContentLoaded',start)}
})()</scr` + `ipt>`;

const POLYFILL_SCRIPT =
  '<script>' + POLYFILLS.join('') + '</scr' + 'ipt>' + BOOT_WATCHDOG_SCRIPT + THEME_BRIDGE_SCRIPT + PICKER_SCRIPT;

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

  /**
   * 结算一次 pick。path 校验（M5，2026-08-16）：只接受真实外部工作区路径
   * （/storage/emulated/0/ 前缀、无 `..` 段、非 content://）——SD 卡/USB
   * 等非 primary 卷的 raw tree URI 在此被明确拒绝（引擎无法用作工作区，
   * 报错而非静默透传）；配合 C1 的 token fail-closed 消除伪造路径面。
   */
  resolve(requestId, path) {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    if (typeof path === 'string' && path !== '' &&
      path.startsWith('/storage/emulated/0/') &&
      !path.split('/').includes('..') &&
      !path.includes('\u0000')) {
      entry.resolve(path)
    } else {
      entry.resolve(null) // 非法路径按取消结算，不落库、不报错路径
    }
    return true
  }
}

export const name = 'host-web-compat';
export const inject = ['webServer'];

export function apply(ctx) {
  // Polyfills + picker bridge script into every index response.
  // 幂等守卫必须用本插件注入内容的独有标记：上游 HTML 自带
  // 'AbortSignal.any' 文本（自带 polyfill 时），用它做守卫会把整个
  // POLYFILL_SCRIPT（含 PICKER_SCRIPT：dir-pick poll 循环 + 上传文件按钮）
  // 误跳过，导致目录选择与文件上传失效（2026-08-16 真机/MuMu 实测）。
  ctx.webServer.tapIndex((html) =>
    html.includes('x-dsh-pick-token') ? html : html.replace('</head>', POLYFILL_SCRIPT + '</head>')
  );

  // Android directory-picker backend: registered as ctx.directoryPicker.
  // 端点鉴权：壳 APK 每次启动生成 DSH_PICK_TOKEN（引擎 env），页面 JS 经
  // androidBridge.getPickToken() 取同一 token 并带 x-dsh-pick-token 头；
  // 本机其他进程/页面无 token，无法轮询或伪造目录选择结果。
  const picker = new AndroidDirectoryPicker(ctx);
  const token = process.env.DSH_PICK_TOKEN || '';
  // C1（2026-08-16）：fail-closed——空 token（引擎被无 token 启动/环境缺失）
  // 时拒绝一切请求，绝不回退放行；壳侧进程级共享 token 保证正常路径
  // 恒非空。本机其他进程无 token 无法轮询或伪造目录选择结果。
  const authorized = (req) => token !== '' && req.headers['x-dsh-pick-token'] === token;
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
