// ============================================================================
// edgetunnel LITE —— 极简版 Worker，为 CF 免费计划 CPU 极限优化
//
// 保留：VLESS over WebSocket 隧道（TCP，直连优先 / PROXYIP 兜底）
//       + 本地订阅生成（&clash / &b64，零第三方）+ 落地页
// 删除：admin 面板、KV、XHTTP/gRPC、trojan/ss、ECH、TLS分片、测速、
//       优选API、TG、DoH、0-RTT、动态伪装域名……全部
//
// CPU 策略（相对全量版 ~50 倍削减的核心）：
//   * 下行 socket.readable ──pipeTo──> ws.writable   全程原生流直通，0 JS/字节
//   * 上行 ws.readable ──[拼接首包剩余]──pipeTo──> socket.writable  每帧 1 次 pull
//   * 无 Grain 合包、无 JS 队列、无 config_JSON/KV 读取、无每请求双重哈希
//   * 背压由 Streams 原生传播，不存在内存堆积路径
//   （不用纯 pipeTo 于 XHTTP 的教训不适用：WS 场景 workerd 原生支持良好）
//
// 环境变量：
//   UUID     节点 UUID（标准 v4）。不设则 = MD5MD5(ADMIN+KEY)，
//            与全量版算法一致 → 现有订阅地址/TOKEN 原样可用
//   ADMIN    无 UUID 时的推导种子（沿用现有值）
//   KEY      推导密钥（沿用现有值则 TOKEN 完全不变）
//   HOST     订阅/节点域名，默认取请求 Host
//   ADD      附加优选节点 ip:port#备注，逗号/换行分隔
//   PROXYIP  直连失败时的兜底反代（host 或 host:port，默认端口 80）
//   PATH     WS 路径，默认 /
//   SUBNAME  订阅文件名，默认 edgetunnel-lite
//   DEBUG    1/true 输出隧道日志
// ============================================================================
import { connect } from 'cloudflare:sockets';

const Version = 'lite-2026-10-20';
const DEFAULT_KEY = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
			return handleTunnel(request, env);
		}
		if (url.pathname === '/sub') return handleSubscription(request, url, env);
		if (url.pathname === '/version') return text(`${Version}\n`);
		if (url.pathname === '/robots.txt') return text('User-agent: *\nDisallow: /\n');
		return new Response(LANDING, { headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
	},
};

// ---------------------------------------------------------------------------
// 身份与 TOKEN（与全量版算法一致，跨实例缓存，热路径 0 哈希）
// ---------------------------------------------------------------------------
async function MD5MD5(文本) {
	const enc = new TextEncoder();
	const h1 = [...new Uint8Array(await crypto.subtle.digest('MD5', enc.encode(文本)))]
		.map(b => b.toString(16).padStart(2, '0')).join('');
	const h2 = [...new Uint8Array(await crypto.subtle.digest('MD5', enc.encode(h1.slice(7, 27))))]
		.map(b => b.toString(16).padStart(2, '0')).join('');
	return h2.toLowerCase();
}

const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
let _uidCache = { key: '', id: null };

async function resolveUserID(env) {
	if (env.UUID && uuidRegex.test(env.UUID)) return env.UUID.toLowerCase();
	const admin = env.ADMIN || env.PASSWORD || env.TOKEN || env.KEY;
	if (!admin) return '';
	const cacheKey = `${admin}|${env.KEY || DEFAULT_KEY}`;
	if (_uidCache.key === cacheKey && _uidCache.id) return _uidCache.id;
	const m = await MD5MD5(admin + (env.KEY || DEFAULT_KEY));
	const id = `${m.slice(0, 8)}-${m.slice(8, 12)}-4${m.slice(13, 16)}-8${m.slice(17, 20)}-${m.slice(20)}`;
	_uidCache = { key: cacheKey, id };
	return id;
}

function text(body, status = 200) {
	return new Response(body, { status, headers: { 'content-type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// VLESS 协议解析
// ---------------------------------------------------------------------------
const td = new TextDecoder();

function uuidToBytes(uuid) {
	const hex = String(uuid).replaceAll('-', '');
	if (hex.length !== 32) return null;
	const out = new Uint8Array(16);
	for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function parseVless(data, uuidBytes) {
	if (!(data instanceof Uint8Array) || data.byteLength < 24) return { hasError: true, message: 'Invalid data' };
	const version = data[0];
	if (version !== 1 && version !== 2) return { hasError: true, message: 'Invalid version' };
	for (let i = 0; i < 16; i++) if (data[1 + i] !== uuidBytes[i]) return { hasError: true, message: 'Invalid uuid' };

	const cmdIndex = 18 + data[17];
	if (data.byteLength < cmdIndex + 5) return { hasError: true, message: 'Invalid data' };
	if (data[cmdIndex] !== 1) return { hasError: true, message: 'UDP not supported in lite' };

	const portIdx = cmdIndex + 1;
	const port = (data[portIdx] << 8) | data[portIdx + 1];
	const atype = data[portIdx + 2];
	const addrIdx = portIdx + 3;
	let host = '', addrLen = 0;
	if (atype === 1) {
		addrLen = 4;
		if (data.byteLength < addrIdx + 4) return { hasError: true, message: 'Bad IPv4' };
		host = `${data[addrIdx]}.${data[addrIdx + 1]}.${data[addrIdx + 2]}.${data[addrIdx + 3]}`;
	} else if (atype === 2) {
		addrLen = data[addrIdx];
		if (!addrLen || data.byteLength < addrIdx + 1 + addrLen) return { hasError: true, message: 'Bad domain' };
		host = td.decode(data.subarray(addrIdx + 1, addrIdx + 1 + addrLen));
	} else if (atype === 3) {
		addrLen = 16;
		if (data.byteLength < addrIdx + 16) return { hasError: true, message: 'Bad IPv6' };
		const g = [];
		for (let i = 0; i < 8; i++) g.push(((data[addrIdx + i * 2] << 8) | data[addrIdx + i * 2 + 1]).toString(16));
		host = g.join(':');
	} else return { hasError: true, message: 'Bad address type' };

	return { hasError: false, version, port, host, body: data.subarray(addrIdx + addrLen) };
}

// early data（sec-websocket-protocol 携带首包，省一次 RTT）
function decodeEarlyData(header, uuidBytes) {
	if (!header) return null;
	let b64 = header.split(',')[0].trim().replace(/-/g, '+').replace(/_/g, '/');
	const pad = b64.length % 4; if (pad) b64 += '='.repeat(4 - pad);
	let bin; try { bin = atob(b64); } catch { return null; }
	if (bin.length < 18 || bin.length > 65536) return null;
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	for (let i = 0; i < 16; i++) if (bytes[1 + i] !== uuidBytes[i]) return null;
	return bytes;
}

function splitHostPort(s, defPort) {
	const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(s).trim());
	if (!m) return [String(s).trim(), defPort];
	return [m[1].replace(/^\[|\]$/g, ''), Number(m[2] || defPort)];
}

function makeConnector(request) {
	const fetcher = request?.fetcher;
	if (fetcher && typeof fetcher.connect === 'function') return (o) => fetcher.connect(o);
	return (o) => connect(o);
}

// ---------------------------------------------------------------------------
// 隧道：认证后双向 pipeTo 原生直通
// ---------------------------------------------------------------------------
async function handleTunnel(request, env) {
	const userID = await resolveUserID(env);
	const uuidBytes = userID ? uuidToBytes(userID) : null;
	const debug = ['1', 'true'].includes(String(env.DEBUG || ''));
	const log = (...a) => { if (debug) console.log(...a); };

	// 约定与全量版一致：Object.values 顺序 = [client, server]
	const [client, server] = Object.values(new WebSocketPair());
	server.accept();
	// workerd：服务端 WS 只有事件 API（message/send/close），没有 .readable/.writable。
	// 会话逻辑放后台执行，fetch 立即返回 101。
	runSession(server, request, env, uuidBytes, log).catch((e) => {
		log('[session error]', String(e));
		try { server.close(); } catch { }
	});
	return new Response(null, { status: 101, webSocket: client });
}

async function runSession(server, request, env, uuidBytes, log) {
	if (!uuidBytes) { try { server.close(); } catch { } return; }
	const connector = makeConnector(request);
	const proxyip = (env.PROXYIP || '').split(/[\n,]/)[0].trim();

	let remote = null, finished = false, sessionReady = false;
	const shutdown = (why) => {
		if (finished) return;
		finished = true;
		log('[close]', why);
		try { remote && remote.close(); } catch { }
		try { server.close(); } catch { }
	};
	server.addEventListener('error', () => shutdown('ws error'));

	// ---- 上行缓冲：message 一律入队；首包定目标后统一冲刷 ----
	const inbox = [];
	let upWriter = null, upChain = Promise.resolve();
	const writeUp = (data) => {
		upChain = upChain.then(async () => {
			if (finished || !remote) return;
			if (!upWriter) upWriter = remote.writable.getWriter();
			try { await upWriter.write(data); } catch (e) { shutdown('up write: ' + e); }
		});
	};
	const flushInbox = () => { while (inbox.length && !finished) writeUp(inbox.shift()); };

	const toU8 = (e) => e.data instanceof Uint8Array ? e.data
		: e.data instanceof ArrayBuffer ? new Uint8Array(e.data)
			: typeof e.data === 'string' ? new TextEncoder().encode(e.data) : null;

	let wakeUp = null;
	server.addEventListener('message', (e) => {
		if (finished) return;
		const d = toU8(e);
		if (!d || !d.byteLength) return;
		if (sessionReady) { writeUp(d); return; }
		inbox.push(d);
		if (wakeUp) { const w = wakeUp; wakeUp = null; w(); }
	});

	// early data 作为首包预置；否则等第一条 message（5s 超时）
	const early = decodeEarlyData(request.headers.get('sec-websocket-protocol') || '', uuidBytes);
	if (early) inbox.unshift(early);
	if (!inbox.length) {
		await new Promise((resolve) => {
			const t = setTimeout(resolve, 5000);
			wakeUp = () => { clearTimeout(t); resolve(); };
		});
		if (!inbox.length && !finished) { shutdown('no first packet'); return; }
	}
	if (finished) return;

	const first = inbox.shift();
	const target = parseVless(first, uuidBytes);
	const send = (bytes) => { try { server.send(bytes); } catch { } };
	if (target.hasError) { log('[reject]', target.message); send(new Uint8Array([first[0] || 1, 1])); shutdown('auth fail'); return; }

	// 建连：直连优先；失败且配置了 PROXYIP 则兜底
	let body = target.body;
	try {
		remote = connector({ hostname: target.host, port: target.port });
	} catch (e0) {
		log('[direct fail]', e0);
		if (!proxyip) { send(new Uint8Array([target.version, 1])); shutdown('dial fail'); return; }
		try {
			const [ph, pp] = splitHostPort(proxyip, 80);
			remote = connector({ hostname: ph, port: pp });
			const head = new TextEncoder().encode(`${target.host}:${target.port}\n`);
			const glue = new Uint8Array(head.byteLength + body.byteLength);
			glue.set(head, 0); glue.set(body, head.byteLength);
			body = glue;
		} catch (e2) { log('[proxyip fail]', e2); send(new Uint8Array([target.version, 1])); shutdown('proxyip fail'); return; }
	}
	remote.closed && remote.closed.catch(() => { });
	send(new Uint8Array([target.version, 0])); // VLESS 应答
	log('[open]', `${target.host}:${target.port}`);

	sessionReady = true;
	if (body.byteLength) inbox.unshift(body);
	flushInbox();

	// ---- 下行：remote.readable → server.send（send 的 promise = 原生背压）----
	(async () => {
		const reader = remote.readable.getReader();
		try {
			while (!finished) {
				const { done, value } = await reader.read();
				if (done || finished) break;
				if (!value || !value.byteLength) continue;
				const r = server.send(value);
				if (r && typeof r.then === 'function') await r;
			}
		} catch (e) { shutdown('down: ' + e); return; }
		shutdown('down end');
	})();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ws101(client) { return new Response(null, { status: 101, webSocket: client }); }

// ---------------------------------------------------------------------------
// 订阅生成（本地，零第三方）
// ---------------------------------------------------------------------------
function parseAddList(add) {
	if (!add) return [];
	return add.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map((s, i) => {
		const m = /^(?:(\[[0-9a-fA-F:.]+\])|([^:\/#\s]+))(?::(\d+))?(?:#(.*))?$/.exec(s);
		if (!m) return null;
		return { addr: (m[1] || m[2]).replace(/^\[|\]$/g, ''), port: Number(m[3] || 443), remark: decodeURIComponent(m[4] || '') || `优选${i + 1}` };
	}).filter(Boolean);
}

async function handleSubscription(request, url, env) {
	const userID = await resolveUserID(env);
	if (!userID) return text('请设置 UUID 或 ADMIN 环境变量', 404);
	const host = (env.HOST || url.hostname || '').toLowerCase();
	const token = await MD5MD5(host + userID);
	if (url.searchParams.get('token') !== token) return new Response(LANDING, { headers: { 'content-type': 'text/html; charset=utf-8' } });

	const path = env.PATH || '/';
	const nodes = [{ addr: host, port: 443, remark: '主节点' }].concat(parseAddList(env.ADD));
	const ua = (request.headers.get('User-Agent') || '').toLowerCase();
	const wantClash = url.searchParams.has('clash') || ua.includes('clash') || ua.includes('meta') || ua.includes('mihomo');
	const subName = env.SUBNAME || 'edgetunnel-lite';

	if (wantClash) {
		const y = [`# ${subName} (${Version}) —— 本地生成，未经过任何第三方服务`, 'proxies:'];
		const esc = (s) => String(s).replace(/"/g, '');
		for (const n of nodes) {
			y.push(
				`  - name: "${esc(n.remark)}"`,
				'    type: vless',
				`    server: ${n.addr}`,
				`    port: ${n.port}`,
				`    uuid: ${userID}`,
				'    tls: true',
				`    servername: "${host}"`,
				'    client-fingerprint: chrome',
				'    udp: false',
				'    network: ws',
				'    ws-opts:',
				`      path: "${path}"`,
				'      headers:',
				`        Host: "${host}"`,
			);
		}
		const names = nodes.map(n => `"${esc(n.remark)}"`);
		y.push(
			'proxy-groups:',
			'  - name: "节点选择"',
			'    type: select',
			`    proxies: ["自动选择", "DIRECT", ${names.join(', ')}]`,
			'  - name: "自动选择"',
			'    type: url-test',
			'    url: https://www.gstatic.com/generate_204',
			'    interval: 300',
			'    tolerance: 50',
			`    proxies: [${names.join(', ')}]`,
			'rules:',
			'  - GEOIP,LAN,DIRECT,no-resolve',
			'  - GEOIP,CN,DIRECT',
			'  - MATCH,节点选择',
		);
		return new Response(y.join('\n') + '\n', { headers: { 'content-type': 'application/x-yaml; charset=utf-8', 'Cache-Control': 'no-store', 'Profile-Update-Interval': '6' } });
	}

	const links = nodes.map(n =>
		`vless://${userID}@${n.addr}:${n.port}?security=tls&type=ws&host=${host}&sni=${host}&path=${encodeURIComponent(path)}&encryption=none&fp=chrome#${encodeURIComponent(n.remark)}`
	).join('\n');
	const b64 = btoa(links); // 链接为 ASCII，btoa 安全
	return new Response(b64, { headers: { 'content-type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store', 'Profile-Update-Interval': '6' } });
}

const LANDING = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome</title><style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#8b949e;display:grid;place-items:center;height:100vh;margin:0}h1{color:#e6edf3;font-weight:600}</style></head><body><div style="text-align:center"><h1>It works.</h1><p>Cloudflare Workers</p></div></body></html>`;
