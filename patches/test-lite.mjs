// et-lite.js 自测：协议解析 / TOKEN 一致性 / 订阅生成 / 隧道 E2E（1MB 逐字节）
// 用法: node patches/test-lite.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- MD5 shim（Node 的 webcrypto 不支持 MD5，用 createHash 桥接）----
const md5 = (buf) => crypto.createHash('md5').update(buf).digest();
globalThis.__md5digest = async (buf) => md5(buf).buffer;

// ---- cloudflare:sockets mock：connect() → TCPSocket 形态 ----
const tmp = path.join(os.tmpdir(), 'et-lite-test');
mkdirSync(tmp, { recursive: true });
const mockFile = path.join(tmp, 'sockets-mock.mjs');
writeFileSync(mockFile, `
import net from 'node:net';
import { Readable, Writable } from 'node:stream';
export function connect({ hostname, port }) {
	const socket = net.createConnection({ host: hostname, port });
	socket.setNoDelay(true);
	let doneFn;
	const closed = new Promise(r => { doneFn = r; });
	socket.on('close', () => doneFn && doneFn());
	socket.on('error', () => { });
	return {
		readable: Readable.toWeb(socket),
		writable: Writable.toWeb(socket),
		info: { localAddress: '127.0.0.1', localPort: 0, remoteAddress: hostname, remotePort: port },
		closed,
		close: () => socket.destroy(),
	};
}
`);

let src = readFileSync(path.join(HERE, '..', 'et-lite.js'), 'utf-8');
src = src.replace(/import \{ connect \} from ('[^']*'|"[^"]*");/, `import { connect } from 'file://${mockFile}';`);
if (src.includes("crypto.subtle.digest")) throw new Error('lite 不应再含 MD5 计算');
// 注入 pair 捕获钩子（模块作用域变量无法经 import 访问，改为导出 setter）
src = src.replace(
	"function text(body, status = 200) {",
	"export function __setPairSink(fn) { globalThis.__pairSink = fn; }\nfunction text(body, status = 200) {");
src = src.replace(
	"const [client, server] = Object.values(new WebSocketPair());",
	"const [client, server] = Object.values(new WebSocketPair());\n\tglobalThis.__pairSink && globalThis.__pairSink({ client, server });");
src += '\nexport { 解析维列斯请求 as parseVless, uuidToBytes, 解码WS早期数据 as decodeEarlyData, resolveUserID, handleSubscription };\n';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
mod.__setPairSink(({ client, server }) => { LAST = { client, server }; });

// ---- 运行时 mock：Request / Response / WebSocketPair ----
function makeRequest(url, headers = {}) {
	const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
	return { url, headers: { get: (k) => h.get(k.toLowerCase()) ?? null } };
}
globalThis.Response = class {
	constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = new Map(Object.entries(init.headers || {})); this.webSocket = init.webSocket; }
};
class WS {
	constructor() {
		this._listeners = { message: [], error: [], close: [] };
		this.written = [];
		this.binaryType = 'blob'; // workerd 默认（websocket_standard_binary_type 兼容标志下）
	}
	accept() { this.accepted = true; }
	send(data) { this.written.push(data instanceof Uint8Array ? data : new Uint8Array(data)); }
	close() { this.closed_ = true; }
	addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
	removeEventListener(type, fn) { const a = this._listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
	_push(chunk) { for (const fn of [...(this._listeners.message || [])]) fn({ data: chunk }); }
	// 模拟 workerd：binaryType='blob' 时二进制帧的 e.data 是 Blob（有 arrayBuffer()，无 byteLength）
	_pushBlob(chunk) {
		const blob = {
			byteLength: chunk.byteLength,
			arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
		};
		for (const fn of [...(this._listeners.message || [])]) fn({ data: blob });
	}
	set binaryType(v) { this._binaryType = v; }
	get binaryType() { return this._binaryType ?? 'blob'; }
}
let LAST = null;
globalThis.WebSocketPair = class {
	constructor() {
		this.client = { tag: 'client' };
		this.server = new WS();
		this[0] = this.client; this[1] = this.server;
	}
};

// ---- 本地 TCP 源站：收到任何请求即回 1MB ----
const BIG = crypto.randomBytes(1024 * 1024);
const origin = net.createServer((sock) => { sock.on('data', () => sock.end(Buffer.from(BIG))); });
await new Promise(r => origin.listen(19002, r));

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const env = { UUID: uuid, HOST: 'et.example.com', PATH: '/' };
function vlessHeader(u, host, port, body) {
	const hex = u.replaceAll('-', '');
	const head = new Uint8Array(26 + body.length);
	head[0] = 1;
	for (let i = 0; i < 16; i++) head[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	head[17] = 0; head[18] = 1;
	head[19] = (port >> 8) & 255; head[20] = port & 255;
	head[21] = 1;
	const quad = host.split('.').map(Number);
	head[22] = quad[0]; head[23] = quad[1]; head[24] = quad[2]; head[25] = quad[3];
	head.set(body, 26);
	return head;
}
const A = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ': ' + msg); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ================= 协议解析 =================
const body0 = new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n');
const hdr = vlessHeader(uuid, '127.0.0.1', 19002, body0);
const t = mod.parseVless(hdr, mod.uuidToBytes(uuid));
A(!t.hasError && t.host === '127.0.0.1' && t.port === 19002 && Buffer.compare(Buffer.from(t.body), body0) === 0, 'parseVless IPv4+body');
A(mod.parseVless(hdr, mod.uuidToBytes('00000000-0000-4000-8000-000000000000')).hasError, 'parseVless 错误UUID拒绝');
A(mod.parseVless(hdr.slice(0, 20), mod.uuidToBytes(uuid)).hasError, 'parseVless 短包拒绝');
const udpHdr = vlessHeader(uuid, '127.0.0.1', 19002, body0); udpHdr[18] = 2;
A(mod.parseVless(udpHdr, mod.uuidToBytes(uuid)).hasError, 'parseVless UDP拒绝(lite)');
{
	const h = new Uint8Array(22 + 16 + 3);
	h[0] = 1; const hex = uuid.replaceAll('-', '');
	for (let i = 0; i < 16; i++) h[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	h[17] = 0; h[18] = 1; h[19] = 1; h[20] = 234; h[21] = 3;
	h[22 + 15] = 1;
	const r = mod.parseVless(h, mod.uuidToBytes(uuid));
	A(!r.hasError && r.host.endsWith(':1') && r.port === 490, 'parseVless IPv6');
}
{
	const name = new TextEncoder().encode('example.com');
	const h = new Uint8Array(24 + 1 + name.length);
	h[0] = 1; const hex = uuid.replaceAll('-', '');
	for (let i = 0; i < 16; i++) h[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	h[17] = 0; h[18] = 1; h[19] = 1; h[20] = 234; h[21] = 2; h[22] = name.length;
	h.set(name, 23);
	const r = mod.parseVless(h, mod.uuidToBytes(uuid));
	A(!r.hasError && r.host === 'example.com', 'parseVless 域名');
}
const eb64 = Buffer.from(hdr).toString('base64');
A(mod.decodeEarlyData(eb64, mod.uuidToBytes(uuid))?.byteLength === hdr.byteLength, 'early data 解码');
A(mod.decodeEarlyData('!!!!', mod.uuidToBytes(uuid)) === null, 'early data 非法→null');

// ================= TOKEN / 身份 =================
A(mod.resolveUserID(env) === uuid, 'resolveUserID env.UUID');
A(mod.resolveUserID({ UUID: uuid.toUpperCase() }) === uuid, '大写 UUID 归一小写');
A(mod.resolveUserID({ UUID: '  ' + uuid + ' ' }) === uuid, '带空格 UUID 容错');
A(mod.resolveUserID({ uuid: uuid }) === uuid, '小写变量名 env.uuid 兼容');
A(mod.resolveUserID({}) === '', '无 UUID → 空（拒绝服务）');
A(mod.resolveUserID({ UUID: 'not-a-uuid' }) === '', '非法 UUID → 空');
const expectToken = uuid; // TOKEN 直接 = UUID
{
	const upper = await mod.handleSubscription(makeRequest('x'), new URL('https://et.example.com/sub?token=' + uuid.toUpperCase() + '&clash'), env);
	A(upper.body.includes('proxies:'), 'URL 大写 token 也通过（大小写不敏感）');
}

// ================= 订阅 =================
const U = (q) => new URL('https://et.example.com/sub?token=' + expectToken + q);
const yamlRes = await mod.handleSubscription(makeRequest('x', { 'user-agent': 'clash-verge' }), U('&clash'), env);
A(yamlRes.body.includes('proxies:') && yamlRes.body.includes('uuid: ' + uuid) && yamlRes.body.includes('type: url-test'), '订阅 &clash → YAML');
A(yamlRes.headers.get('content-type').includes('x-yaml'), 'clash content-type');
A(yamlRes.body.includes('server: et.example.com'), '主节点=HOST');
const yaml2 = (await mod.handleSubscription(makeRequest('x'), U('&clash'), { ...env, ADD: '1.2.3.4:8443#A电信,[2606:4700::1]:443#B,5.6.7.8' })).body;
A(yaml2.includes('server: 1.2.3.4') && yaml2.includes('port: 8443') && yaml2.includes('server: 2606:4700::1') && yaml2.includes('port: 443') && yaml2.includes('server: 5.6.7.8'), 'ADD 解析(ip:port/ipv6/裸ip)');
A(yaml2.includes('name: "A电信"'), 'ADD 备注 URL解码');
const b64Res = await mod.handleSubscription(makeRequest('x'), U('&b64'), env);
A(Buffer.from(b64Res.body, 'base64').toString('utf-8').startsWith('vless://' + uuid + '@et.example.com:443'), '订阅 &b64');
const badRes = await mod.handleSubscription(makeRequest('x'), new URL('https://et.example.com/sub?token=WRONG&clash'), env);
A(badRes.headers.get('content-type').includes('html'), '错误TOKEN→落地页');
const uaRes = await mod.handleSubscription(makeRequest('x', { 'user-agent': 'Clash/1.0' }), U(''), env);
A(uaRes.body.includes('proxies:'), 'UA=Clash 自动给 YAML');

// ================= 隧道 E2E =================
{
	const resp = await mod.default.fetch(makeRequest('wss://et.example.com/', { upgrade: 'websocket' }), env);
	A(resp.status === 101, '隧道升级 101');
	const server = LAST.server;
	server._push(hdr);
	await sleep(600);
	const total = server.written.reduce((s, c) => s + c.byteLength, 0);
	const flat = Buffer.concat(server.written.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
	A(flat[0] === 1 && flat[1] === 0, 'VLESS 响应头 [1,0]');
	A(total === 2 + BIG.length, `下行 1MB 完整回传 (${total}B)`);
	A(Buffer.compare(flat.subarray(2), BIG) === 0, '下行内容逐字节一致');
}
{
	const bad = vlessHeader('11111111-1111-4111-8111-111111111111', '127.0.0.1', 19002, body0);
	await mod.default.fetch(makeRequest('wss://et.example.com/', { upgrade: 'websocket' }), env);
	LAST.server._push(bad);
	await sleep(200);
	const flat = Buffer.concat(LAST.server.written.map(c => Buffer.from(c)));
	A(flat.length === 2 && flat[0] === 1 && flat[1] === 1, '错误UUID → [1,1] 拒绝');
}
{
	await mod.default.fetch(makeRequest('wss://et.example.com/', { upgrade: 'websocket', 'sec-websocket-protocol': eb64 }), env);
	await sleep(600);
	const flat = Buffer.concat(LAST.server.written.map(c => Buffer.from(c)));
	A(flat[0] === 1 && flat[1] === 0 && flat.length === 2 + BIG.length, 'early data 免首帧直传');
}
// ---- binaryType / Blob 兜底（workerd websocket_standard_binary_type 兼容标志下 e.data 为 Blob）----
{
	const resp = await mod.default.fetch(makeRequest('wss://et.example.com/', { upgrade: 'websocket' }), env);
	A(LAST.server.binaryType === 'arraybuffer', '隧道显式设置 binaryType=arraybuffer（防 Blob 静默丢包）');
	LAST.server._pushBlob(hdr); // 模拟 binaryType 未生效时 e.data 为 Blob
	await sleep(600);
	const flat = Buffer.concat(LAST.server.written.map(c => Buffer.from(c)));
	A(flat[0] === 1 && flat[1] === 0 && flat.length === 2 + BIG.length, 'Blob 首包兜底：arrayBuffer() 转换后隧道正常');
}
origin.close();
console.log('=== done ===');
