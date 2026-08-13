// @dsh-android/dsh-host-web-compat
// 通过 webServer.tapIndex 在每次 index 响应注入缺失的浏览器 API polyfill。
// 背景：老内核（MuMu 自带浏览器 / 旧 WebView）缺 AbortSignal.any()，
// 导致 dsh 目录选择器（browse picker）的 RPC 并发取消直接抛错、列表为空。
// 修复后目录选择器在旧内核浏览器中完整可用（M0 实测已验证）。

/** 每个缺失 API 的 polyfill 片段（幂等：已存在则跳过）。 */
const POLYFILLS = [
  // AbortSignal.any: Chrome 116+/Node 20.3+；老 WebView 无
  `if(typeof AbortSignal!=='undefined'&&!AbortSignal.any){AbortSignal.any=function(s){var c=new AbortController(),f=function(){c.abort()};for(var i=0;i<s.length;i++){if(s[i].aborted){c.abort();return c.signal}s[i].addEventListener('abort',f,{once:true})}return c.signal}}`,
  // structuredClone: Chrome 98+/Node 17+；更老的 WebView 无
  `if(typeof structuredClone==='undefined'){structuredClone=function(v){return JSON.parse(JSON.stringify(v))}}`
];

const POLYFILL_SCRIPT =
  '<script>' + POLYFILLS.join('') + '</scr' + 'ipt>';

export const name = 'host-web-compat';
export const inject = ['webServer'];

export function apply(ctx) {
  ctx.webServer.tapIndex((html) =>
    html.includes('AbortSignal.any') ? html : html.replace('</head>', POLYFILL_SCRIPT + '</head>')
  );
}
