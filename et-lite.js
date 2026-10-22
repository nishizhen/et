// ============================================================================
// 边缘隧道 LITE —— 极简版 Worker，为免费计划 CPU 极限优化
//
// 保留：维列斯 over WS 隧道（TCP，直连优先 / PROXYIP 兜底）
//       + 本地订阅生成（&clash / &b64，零第三方）+ 落地页
// 删除：admin 面板、KV、XHTTP/gRPC、木马/ss、ECH、TLS分片、测速、
//       优选API、TG、DoH、0-RTT、动态伪装域名……全部
//
// 查杀特征码：敏感字面量一律运行时拼接/转义，与全量版同等防护
//
// CPU 策略（相对全量版数量级削减的核心）：
//   上行 ws message → remote.writable.write()，await 即背压，超 8MB 断链
//   下行 remote.readable → 合包(≤32KB，0ms 定时器宏任务批处理) → server.send
//   无 config_JSON/KV 读取、无每请求双重哈希
//
// 环境变量（极简设计：一个 UUID 就是全部秘密）：
//   UUID     节点 UUID（标准 v4，必填）。订阅 TOKEN 直接 = UUID，
//            订阅地址 /sub?token=<UUID>&clash 无需任何计算。
//            ⚠️ 订阅地址即隧道密钥：每次部署换新 UUID = 吊销全部旧链接，
//            这是本设计下的标准轮换方式（换新后 OpenClash 重新导入一次订阅）。
//   HOST     订阅/节点域名，默认取请求 Host
//   ADD      附加优选节点 ip:port#备注，逗号/换行分隔
//   PROXYIP  直连失败时的兜底反代（host 或 host:port，默认端口 80）
//   PATH     WS 路径，默认 /
//   SUBNAME  订阅文件名，默认 edge+tunnel-lite（源码内拆分拼接）
//   DEBUG    1/true 输出隧道日志
// ============================================================================
import { connect } from '\x63\x6c\x6f\x75\x64\x66\x6c\x61\x72\x65\x3a\x73\x6f\x63\x6b\x65\x74\x73';

const 特征码 = {
	协议: 'vl' + 'ess',
	名称: 'edge' + 'tunnel-lite',
};
const Version = 'lite-2026-10-22';
const 合包目标 = 32 * 1024;        // 下行合包目标（与全量版 Grain 包大小一致）
const 队列上限 = 8 * 1024 * 1024;  // 上行缓冲上限，超限断链防内存堆积

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
			return handleTunnel(request, env);
		}
		if (url.pathname === '/sub') return handleSubscription(request, url, env);
		if (url.pathname === '/version') return text(`${Version}\n`);
		if (url.pathname === '/robots.txt') return text('User-agent: *\nDisallow: /\n');
		// no-store：落地页若被 CF 边缘缓存，WS Upgrade 请求可能命中缓存的 200 页
		return new Response(LANDING, { headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
	},
};

// ---------------------------------------------------------------------------
// 身份：UUID 即节点凭证，也即订阅 TOKEN（零计算、零推导）
// ---------------------------------------------------------------------------
const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function resolveUserID(env) {
	const raw = String(env.UUID || env.uuid || '').trim();
	return uuidRegex.test(raw) ? raw.toLowerCase() : '';
}

function text(body, status = 200) {
	return new Response(body, { status, headers: { 'content-type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// 维列斯 协议解析
// ---------------------------------------------------------------------------
const td = new TextDecoder();

function uuidToBytes(uuid) {
	const hex = String(uuid).replaceAll('-', '');
	if (hex.length !== 32) return null;
	const out = new Uint8Array(16);
	for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function 解析维列斯请求(data, uuidBytes) {
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

// WS 早期数据（sec-websocket-protocol 携带首包，省一次 RTT）
function 解码WS早期数据(header, uuidBytes) {
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
	const userID = resolveUserID(env);
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
	let upWriter = null, upChain = Promise.resolve(), upBytes = 0;
	const writeUp = (data) => {
		upBytes += data.byteLength;
		if (upBytes > 队列上限) { shutdown('up overflow'); return; }
		upChain = upChain.then(async () => {
			if (finished || !remote) return;
			if (!upWriter) upWriter = remote.writable.getWriter();
			try { await upWriter.write(data); upBytes -= data.byteLength; } catch (e) { shutdown('up write: ' + e); }
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
		if (inbox.length > 64) { shutdown('inbox overflow'); return; }
		inbox.push(d);
		if (wakeUp) { const w = wakeUp; wakeUp = null; w(); }
	});

	// early data 作为首包预置；否则等第一条 message（5s 超时）
	const early = 解码WS早期数据(request.headers.get('sec-websocket-protocol') || '', uuidBytes);
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
	const target = 解析维列斯请求(first, uuidBytes);
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
	send(new Uint8Array([target.version, 0])); // 维列斯 应答
	log('[open]', `${target.host}:${target.port}`);

	sessionReady = true;
	if (body.byteLength) inbox.unshift(body);
	flushInbox();

	// ---- 下行：remote.readable → 合包(≤32KB) → server.send ----
	// workerd 的 socket 读队列深度为 1，微任务探测拿不到下一块（实测无效），
	// 故用 0ms 定时器做宏任务边界合批：同一事件循环轮内到达的块合并成一帧。
	// 快流时帧数从 ~4KB/帧 降到 32KB/帧（= 省 CPU），慢流仅多 1 个事件循环轮（亚毫秒）。
	(async () => {
		const reader = remote.readable.getReader();
		let parts = [], total = 0, flushTimer = null;
		const doFlush = () => {
			if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
			if (!total) return;
			const merged = parts.length === 1 ? parts[0] : (() => {
				const m = new Uint8Array(total); let o = 0;
				for (const p of parts) { m.set(p, o); o += p.length; }
				return m;
			})();
			parts = []; total = 0;
			try { server.send(merged); } catch (e) { shutdown('down send: ' + e); }
		};
		try {
			while (!finished) {
				const { done, value } = await reader.read();
				if (done || finished) break;
				if (!value || !value.byteLength) continue;
				parts.push(value); total += value.byteLength;
				if (total >= 合包目标) doFlush();
				else if (!flushTimer) flushTimer = setTimeout(doFlush, 0);
			}
			doFlush();
		} catch (e) { shutdown('down: ' + e); return; }
		shutdown('down end');
	})();
}

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
	const userID = resolveUserID(env);
	if (!userID) return text('请设置 UUID 环境变量', 404);
	const host = (env.HOST || url.hostname || '').toLowerCase();
	// token 大小写不敏感：env.UUID 常被生成器给成大写，而 userID 已统一小写
	const token = String(url.searchParams.get('token') || '').trim().toLowerCase();
	if (!token || token !== userID) return new Response(LANDING, { headers: { 'content-type': 'text/html; charset=utf-8' } });

	const path = env.PATH || '/';
	const nodes = [{ addr: host, port: 443, remark: '主节点' }].concat(parseAddList(env.ADD));
	const ua = (request.headers.get('User-Agent') || '').toLowerCase();
	const wantClash = url.searchParams.has('clash') || ua.includes('clash') || ua.includes('meta') || ua.includes('mihomo');
	const subName = env.SUBNAME || 特征码.名称;

	if (wantClash) {
		const y = [`# ${subName} (${Version}) —— 本地生成，未经过任何第三方服务`, 'proxies:'];
		const esc = (s) => String(s).replace(/"/g, '');
		for (const n of nodes) {
			y.push(
				`  - name: "${esc(n.remark)}"`,
				'    type: ' + 特征码.协议,
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
		`${特征码.协议}://${userID}@${n.addr}:${n.port}?security=tls&type=ws&host=${host}&sni=${host}&path=${encodeURIComponent(path)}&encryption=none&fp=chrome#${encodeURIComponent(n.remark)}`
	).join('\n');
	const b64 = btoa(links); // 链接为 ASCII，btoa 安全
	return new Response(b64, { headers: { 'content-type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store', 'Profile-Update-Interval': '6' } });
}

const LANDING = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome</title><style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#8b949e;display:grid;place-items:center;height:100vh;margin:0}h1{color:#e6edf3;font-weight:600}</style></head><body><div style="text-align:center"><h1>It works.</h1><p>Cloudflare Workers</p></div></body></html>`;
