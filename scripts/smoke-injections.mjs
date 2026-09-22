// smoke-injections.mjs — boot the plugin against a stubbed cordis, run its real tapIndex
// transform, and parse-check every inline <script> it injects.
//
// Why this exists (2026-09-10, WebView 110 / MuMu): the polyfill snippets used to be joined with
// '' — the Set-methods snippet ends with an expression (`})()`) and the next one starts with
// `if (`, so the parser rejected the WHOLE element and every polyfill died silently. The served
// HTML still contained the shim text, so grep-style checks passed while the page reported
// "Iterator is not defined". Only parsing the assembled markup catches that class of defect.
//
// Usage: node scripts/smoke-injections.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-web-compat-smoke-'))
const failures = []

/** Assert one condition, recording the failure instead of throwing so all checks report. */
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

try {
  // The plugin imports @deepseek-ai/cordis; the smoke test supplies a Service stub so the package
  // needs no install (the plugin ships lib/ only).
  const stub = join(scratch, 'node_modules', '@deepseek-ai', 'cordis')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '0.0.0-stub', type: 'module', main: 'index.js' }))
  writeFileSync(join(stub, 'index.js'), 'export class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name } }\n')
  const pluginCopy = join(scratch, 'plugin.mjs')
  copyFileSync(join(pluginRoot, 'lib', 'index.js'), pluginCopy)

  const mod = await import(pathToFileURL(pluginCopy).href)
  const transforms = []
  const ctx = {
    webServer: {
      tapIndex: (fn) => { transforms.push(fn) },
      register: () => () => {},
    },
    effect: () => () => {},
    get: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  mod.apply(ctx)
  check('plugin exports name/inject/apply', mod.name === 'host-web-compat' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
  // 接线契约是**两条** transform：① polyfill+主题桥+picker（共用 pick-token 幂等判据）；
  // ② 静态失败占位（自带哨兵，刻意不共用判据，见 lib/index.js 的 tapIndex 注释）。
  // 此前这里断言「恰好一条」并只跑 transforms[0] —— 于是块C 新增的静态占位脚本
  // **从未被本门禁解析检查过**：一道看不见自己盲区的防线（0.14.1 白闪缺陷 D4 的旁证）。
  // 现在先断言条数契约（新增注入面必须显式更新本行 → 强制其进入下方逐段解析），再逐条应用。
  check('registers the polyfill + static-fallback index transforms', transforms.length === 2, String(transforms.length))

  // 逐条应用（而不是只看 transforms[0]）：每一条注入的脚本体都要过下面的解析与标记检查。
  const html = transforms.reduce((acc, fn) => fn(acc), '<html><head><title>t</title></head><body></body></html>')
  check('injects before </head>', html.includes('</head>') && html.indexOf('Promise.withResolvers') < html.indexOf('</head>'))
  check('static fallback lands before the document head end',
    html.indexOf('dsh-static-fallback') > 0 && html.indexOf('dsh-static-fallback') < html.indexOf('</head>'))

  const bodies = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  check('injects at least 4 script elements', bodies.length >= 4, String(bodies.length))
  for (const [index, body] of bodies.entries()) {
    try {
      new Function(body)
      check('script #' + (index + 1) + ' parses (' + body.length + ' bytes)', true)
    } catch (error) {
      check('script #' + (index + 1) + ' parses (' + body.length + ' bytes)', false, error.message)
    }
  }

  // Live-page markers: the polyfills must be reachable from the served text, not merely present in
  // the plugin source (the failure mode this gate exists for).
  for (const [label, needle] of [
    ['Promise.withResolvers polyfill', 'Promise.withResolvers=function'],
    ['Iterator global shim', "Object.defineProperty(globalThis,'Iterator'"],
    ['Iterator constructor shape (Iterator.prototype)', 'Object.defineProperty(IteratorCtor,\'prototype\''],
    ['Object.groupBy shim', 'Object.groupBy=function'],
    ['Set.prototype.union shim', "def('union'"],
    ['Array.fromAsync shim', 'Array.fromAsync=async function'],
    ['AbortSignal.any polyfill', 'AbortSignal.any=function'],
    ['directory-picker bridge', 'x-dsh-pick-token'],
    ['theme bridge', '__dshThemeBridge'],
    // D4/F1（0.14.1 白闪，issue #242）：入口 chunk 绘制前文档画布是默认白，必须在 head 解析期
    // 就设主题底色。这里只锁「标记送达页面」；**行为**由 boot-watchdog.test.mjs 的 F1 用例判。
    ['boot canvas theme', 'applyCanvasTheme'],
    ['static failure fallback sentinel', 'id="dsh-static-fallback"'],
    ['static fallback hidden by default', 'visibility:hidden'],
  ]) check('served markup carries ' + label, html.includes(needle))

  // Behavioural proof for the shape of the Iterator shim: run the real polyfill script inside a
  // realm with Iterator deleted (the WebView 110 situation) and then evaluate pdfjs's own guard.
  // A bare {from} object passes every text check above and still throws here.
  const { createContext, runInContext } = await import('node:vm')
  const realm = createContext({ console })
  const polyfillBody = bodies.find((body) => body.includes("typeof Iterator==='undefined'"))
  check('polyfill script located for the realm probe', typeof polyfillBody === 'string')
  if (typeof polyfillBody === 'string') {
    // Chromium 110 has neither the Iterator global nor the helper methods; deleting only the global
    // would let the realm's native helpers answer the probe and hide a broken wrapper.
    runInContext(`(() => {
      const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))
      for (const name of ['map', 'filter', 'take', 'drop', 'flatMap', 'toArray', 'forEach', 'some', 'every', 'find', 'reduce']) {
        try { delete proto[name] } catch { /* non-configurable: leave it, the probe would then be weaker */ }
      }
      delete globalThis.Iterator
    })()`, realm)
    try {
      runInContext(polyfillBody, realm)
      check('polyfill script executes with Iterator absent', true)
    } catch (error) {
      check('polyfill script executes with Iterator absent', false, error.message)
    }
    const probe = runInContext(`(() => {
      const report = { iterator: typeof Iterator, prototype: typeof Iterator.prototype, withResolvers: typeof Promise.withResolvers }
      // pdfjs (bundled by ui-sidebar-documentpreview) runs exactly this at module init.
      if (typeof Iterator.prototype.join !== 'function') Iterator.prototype.join = function (separator) { return [...this].join(separator) }
      report.join = [3, 1, 2].values().join('-')
      report.toArray = Iterator.from([1, 2]).map((v) => v * 2).toArray().join(',')
      return report
    })()`, realm)
    check('pdfjs Iterator.prototype.join guard survives', typeof probe.prototype === 'string' || probe.prototype === 'object', JSON.stringify(probe))
    check('iterator helpers answer through the shim', probe.join === '3-1-2' && probe.toArray === '2,4', JSON.stringify(probe))
    check('Promise.withResolvers installed by the same script', probe.withResolvers === 'function', JSON.stringify(probe))
  }

  const guarded = transforms[0]('<html><head>x-dsh-pick-token</head><body></body></html>')
  check('idempotent guard skips a page that already carries the injection', guarded === '<html><head>x-dsh-pick-token</head><body></body></html>')

  // 静态占位自带独立哨兵，**刻意不共用** pick-token 判据：入口 chunk 全灭时它是唯一的可见反馈，
  // 与 pick-token 共用判据会被一起跳过（lib/index.js 的 tapIndex 注释里逐字写了这条理由）。
  const fallbackOnce = transforms[1]('<html><head></head><body></body></html>')
  check('static fallback transform is idempotent (own sentinel)', transforms[1](fallbackOnce) === fallbackOnce)
  check('static fallback is NOT skipped by the pick-token sentinel',
    transforms[1]('<html><head>x-dsh-pick-token</head><body></body></html>').includes('dsh-static-fallback'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\nsmoke-injections: ' + failures.length + ' check(s) failed: ' + failures.join('; '))
  process.exit(1)
}
console.log('\nsmoke-injections: all checks passed')
