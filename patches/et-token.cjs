#!/usr/bin/env node
// 本地推算 edgetunnel 2.1.x 的订阅 TOKEN 与节点 UUID。
// 与 Worker 内 MD5MD5() 完全一致，纯本地计算，不发起任何网络请求。
//
// 用法 A —— 你设置了 UUID 变量（推荐，节点身份与后台密码解耦）:
//   node et-token.cjs <域名> --uuid <你的UUIDv4>
//
// 用法 B —— 你没有设置 UUID，节点身份由 ADMIN + KEY 推导:
//   node et-token.cjs <域名> --admin <ADMIN> [--key <KEY>]

const crypto = require('crypto');

function parseArgs(argv) {
	const out = {};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
		else if (!out.host) out.host = a;
	}
	return out;
}

const args = parseArgs(process.argv);
if (!args.host) {
	console.error('用法: node et-token.cjs <域名> [--uuid <UUIDv4> | --admin <ADMIN> [--key <KEY>]]');
	process.exit(1);
}

const DEFAULT_KEY = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
const host = args.host.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

const md5hex = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const MD5MD5 = (s) => md5hex(md5hex(s));
const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

let userID, mode;
if (args.uuid) {
	if (!uuidRegex.test(args.uuid)) {
		console.error(`❌ --uuid 不是标准 UUIDv4 格式: ${args.uuid}`);
		console.error('   非 UUIDv4 会导致节点无法使用（见上游 README）。');
		process.exit(1);
	}
	userID = args.uuid.toLowerCase();
	mode = 'env.UUID 已设置 → 节点 UUID = 该 UUID';
} else if (args.admin) {
	const key = args.key || DEFAULT_KEY;
	const m = MD5MD5(args.admin + key);
	userID = [
		m.slice(0, 8), m.slice(8, 12),
		'4' + m.slice(13, 16), '8' + m.slice(17, 20), m.slice(20),
	].join('-');
	mode = 'env.UUID 未设置 → 节点 UUID 由 ADMIN + KEY 推导';
	if (!args.key) console.warn('⚠️  未提供 --key，使用源码内公开默认值；生产环境请务必设置 KEY 变量。');
} else {
	console.error('必须提供 --uuid 或 --admin 之一。');
	process.exit(1);
}

const token = MD5MD5(host + userID);

console.log(`域名        : ${host}`);
console.log(`推导方式    : ${mode}`);
console.log(`节点 UUID   : ${userID}`);
console.log(`订阅 TOKEN  : ${token}`);

console.log('\n--- OpenClash 订阅地址 ---');
console.log('# 零第三方依赖（本地生成，不访问 SUBAPI / GitHub / DoH）');
console.log(`https://${host}/sub?token=${token}&b64`);
console.log('\n# 单个节点直连链接（面板里也能拿到）');
console.log(`vless://${userID}@${host}:443?security=tls&type=ws&host=${host}&sni=${host}&encryption=none`);
