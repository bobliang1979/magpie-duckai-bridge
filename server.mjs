/**
 * Duck.ai → OpenAI 兼容 HTTP 服务
 * 端口 3426，暴露 /v1/models 和 /v1/chat/completions
 *
 * 状态：VERIFIED（2026-11-21 全链路实测：VQD 挑战解算 + SSE 返回 DUCK_VERIFIED）
 * 依赖：jsdom（解 VQD 挑战）、undici（Node fetch 走代理）
 *
 * 关键约束：
 * - duck.ai 直连被地域封锁（451），必须走本机代理 29758（出口 207.174.5.191）
 * - 只有 accessTier 含 'free' 的模型可匿名调用；plus/pro 模型返回 404 ERR_MODEL_RESTRICTED
 * - VQD 挑战需每次请求重新获取并解算（jsdom iframe 模拟真实浏览器）
 */
import http from 'node:http';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

const PORT = Number(process.env.DUCKAI_PORT || 3426);
const PROXY = process.env.DUCKAI_PROXY || 'http://127.0.0.1:29758';
const UA = process.env.DUCKAI_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const VQD_STACK = process.env.DUCKAI_VQD_STACK || 'l@https://duck.ai/dist/duckai-dist/entry.duckai.c9340e95bd2f7fdc3302.js:2:1308110\n';

setGlobalDispatcher(new ProxyAgent(PROXY));

// ---- VQD 挑战 ----
async function getVQD() {
  const r = await fetch('https://duck.ai/duckchat/v1/status', {
    headers: { 'accept':'*/*','accept-language':'en-US,en;q=0.9,fa;q=0.8','cache-control':'no-store','x-vqd-accept':'1','User-Agent':UA },
    referrer: 'https://duck.ai/', referrerPolicy: 'origin',
    signal: AbortSignal.timeout(8000) // 防止上游/代理挂起导致无限等待
  });
  if (!r.ok) throw new Error('duck.ai status HTTP ' + r.status);
  const h = r.headers.get('x-vqd-hash-1');
  if (!h) throw new Error('missing x-vqd-hash-1');
  return h;
}

async function solveVQD(hash) {
  const js = Buffer.from(hash, 'base64').toString('utf-8');
  const dom = new JSDOM(`<iframe id="jsa" sandbox="allow-scripts allow-same-origin" srcdoc="<!DOCTYPE html><html><head><meta http-equiv=&quot;Content-Security-Policy&quot; content=&quot;default-src 'none'; script-src 'unsafe-inline'&quot;></head><body></body></html>" style="position:absolute;left:-9999px;top:-9999px;"></iframe>`, {runScripts:'dangerously'});
  dom.window.top.__DDG_BE_VERSION__ = 1;
  dom.window.top.__DDG_FE_CHAT_HASH__ = 1;
  const jsa = dom.window.top.document.querySelector('#jsa');
  const cd = jsa.contentDocument || jsa.contentWindow.document;
  const meta = cd.createElement('meta');
  meta.setAttribute('http-equiv','Content-Security-Policy');
  meta.setAttribute('content',"default-src 'none'; script-src 'unsafe-inline';");
  cd.head.appendChild(meta);
  const result = await dom.window.eval(js);
  result.client_hashes[0] = UA;
  result.client_hashes = result.client_hashes.map(t => createHash('sha256').update(t).digest('base64'));
  if (result.meta && typeof result.meta === 'object') {
    result.meta.origin = 'https://duck.ai';
    result.meta.stack = VQD_STACK;
    result.meta.duration = String(20 + Math.floor(Math.random()*30));
  }
  dom.window.close();
  return Buffer.from(JSON.stringify(result)).toString('base64');
}

// ---- 模型目录（缓存 1h）----
let modelCache = null, modelCacheAt = 0;
async function getModels() {
  if (modelCache && Date.now() - modelCacheAt < 3600000) return modelCache;
  const r = await fetch('https://duck.ai/duckchat/v1/models', {headers:{'User-Agent':UA}});
  if (!r.ok) throw new Error('models HTTP ' + r.status);
  const d = await r.json();
  modelCache = (d.models || []).map(m => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now()/1000),
    owned_by: m.provider || 'duck.ai',
    free: (m.accessTier || []).includes('free'),
    name: m.name
  }));
  modelCacheAt = Date.now();
  return modelCache;
}

// ---- chat：调 duck.ai，解析 SSE 成 OpenAI 格式 ----
async function duckChat(body) {
  // Magpie 可能传入带 provider 前缀的模型名（duck-ai/gpt-5.4-mini），只剥第一段 provider。
  // tinfoil/gpt-oss-120b 这类名字本身含 /，必须保留（只剥 duck-ai/ 这一段）。
  let model = body.model || 'claude-haiku-5-5';
  if (model.startsWith('duck-ai/')) model = model.slice('duck-ai/'.length);
  // duck.ai 只接受 user/assistant role；system/developer/tool 一律转成 user 文本前缀，
  // 否则 400 ERR_BAD_REQUEST（Codex 必发 developer 消息，这是它用不了的根因）
  const messages = (body.messages || []).map(m => {
    let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    let role = m.role;
    if (role === 'system' || role === 'developer') {
      content = `[系统指令]\n${content}`;
      role = 'user';
    } else if (role === 'tool') {
      content = `[工具结果]\n${content}`;
      role = 'user';
    }
    return {role, content};
  });
  const payload = {model, messages, canUseTools:false, reasoningEffort:'none'};
  let r = null, text = '', lastErr = null;
  // 总预算硬约束：绝不超过 Agent ~25s 超时（否则被取消→"回复中断/请继续"）。
  // 单次 fetch 也有超时，防止上游/代理挂起。18s 预算留 7s 余量给网关+Agent。
  const deadline = Date.now() + 18000;
  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
    try {
      const hash = await getVQD();
      const solved = await solveVQD(hash);
      r = await fetch('https://duck.ai/duckchat/v1/chat', {
        method:'POST',
        headers:{
          'accept':'text/event-stream','accept-language':'en-US,en;q=0.9','cache-control':'no-cache',
          'content-type':'application/json','pragma':'no-cache','priority':'u=0',
          'sec-fetch-dest':'empty','sec-fetch-mode':'cors','sec-fetch-site':'same-origin',
          'User-Agent':UA, 'x-vqd-hash-1':solved
        },
        referrer:'https://duck.ai/', referrerPolicy:'origin', body:JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(2000, Math.min(10000, deadline - Date.now()))) // 单次≤10s，且不超总预算
      });
      text = await r.text();
      lastErr = null;
      if (r.status !== 418) break;
    } catch (e) {
      lastErr = e; r = null;
      if (Date.now() >= deadline) break; // 总预算到，放弃
    }
    if (Date.now() + 1500 >= deadline) break; // 没时间再退避重试
    await new Promise(ok => setTimeout(ok, 500 + attempt * 500)); // 0.5/1/1.5s
  }
  if (!r) {
    const err = new Error(`duck.ai 请求超时/失败: ${lastErr?.message || '超过18s预算'}`);
    err.status = 504;
    throw err;
  }
  if (!r.ok) {
    let detail = text.slice(0,300);
    try { detail = JSON.parse(text).type || detail; } catch {}
    const err = new Error(`duck.ai HTTP ${r.status}: ${detail}`);
    err.status = r.status === 404 ? 400 : (r.status === 429 ? 429 : 502);
    throw err;
  }
  // 解析 SSE: 每行 data: {...} 取 message
  let content = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try { const d = JSON.parse(line.slice(6)); if (d.message) content += d.message; } catch {}
  }
  return content;
}

// ---- 并发锁：串行化 duck.ai 请求，避免同时解挑战互相触发 418 ----
let _queue = Promise.resolve();
function withLock(fn) {
  const result = _queue.then(fn, fn);
  _queue = result.catch(() => {});
  return result;
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/models') {
      const models = await getModels();
      return send(200, {object:'list', data: models.map(({free, name, ...m}) => m)});
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      // 串行化 duckChat，避免并发解挑战互相触发 418
      const content = await withLock(() => duckChat(body));
      const id = 'chatcmpl-duck-' + Date.now();
      if (body.stream) {
        res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
        const chunk = {id, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model:body.model||'claude-haiku-5-5', choices:[{index:0, delta:{content}, finish_reason:null}]};
        res.write('data: ' + JSON.stringify(chunk) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return send(200, {id, object:'chat.completion', created:Math.floor(Date.now()/1000), model:body.model||'claude-haiku-5-5', choices:[{index:0, message:{role:'assistant', content}, finish_reason:'stop'}]});
    }
    if (url.pathname === '/health') return send(200, {ok:true, provider:'duckai', proxy:PROXY});
    return send(404, {error:{message:'not found'}});
  } catch (e) {
    console.error('[duckai-bridge] error:', e.message);
    return send(e.status || 500, {error:{message:e.message, type:'duckai_error'}});
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[duckai-bridge] VERIFIED provider listening on http://127.0.0.1:${PORT}/v1 (proxy ${PROXY})`));
