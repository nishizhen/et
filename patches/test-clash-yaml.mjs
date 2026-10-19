// [本地补丁] 自测：从 ../_worker.js 提取 本地生成ClashYAML 并断言行为
// 用法: node patches/test-clash-yaml.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, '_worker.js'), 'utf-8');

const start = src.indexOf('function 本地生成ClashYAML');
const end = src.indexOf('function Clash订阅配置文件热补丁');
if (start === -1 || end === -1 || end < start) {
	console.error('FAIL: 未找到 [本地补丁] 函数 —— 补丁未应用或上游结构已变化，请重放补丁');
	process.exit(1);
}
const 本地生成ClashYAML = new Function(`${src.slice(start, end)}; return 本地生成ClashYAML;`)();

const links = [
	'vless://00000000-0000-4000-8000-000000000000@104.16.1.1:443?security=tls&type=ws&host=example.com&fp=chrome&sni=example.com&path=%2F%3Fed%3D2560&encryption=none&alpn=#%23CF%E7%94%B5%E4%BF%A1%E4%BC%98%E9%80%891',
	'vless://90cd4a77-141a-43c9-991b-08263cfe9c10@[2606:4700::1]:8443?security=tls&type=ws&host=et.example.com&fp=chrome&sni=et.example.com&path=/&encryption=none#CF随机2',
	'trojan://somepass@1.2.3.4:443?security=tls&type=tcp&sni=et.example.com#Trojan节点',
].join('\n');

const yaml = 本地生成ClashYAML(links, {});
let failed = 0;
const A = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ': ' + msg); if (!cond) failed++; };

A(yaml.includes('proxies:'), '含 proxies 段');
A(yaml.includes('uuid: 00000000-0000-4000-8000-000000000000'), 'vless uuid 解析');
A(yaml.includes('CF电信优选1'), 'URL 编码备注解码');
A(yaml.includes('server: 2606:4700::1'), 'IPv6 去方括号');
A(yaml.includes('path: "/?ed=2560"'), 'ws path URL 解码');
A(yaml.includes('password: "somepass"'), 'trojan password');
A(yaml.includes('client-fingerprint: chrome'), 'TLS 指纹透传');
A(yaml.includes('type: url-test'), 'url-test 自动选择组');
A(!yaml.includes('alpn: []'), '空 alpn 不输出');
A(本地生成ClashYAML('ss://abc@1.1.1.1:8389#x', {}) === 'ss://abc@1.1.1.1:8389#x', '无匹配链接原样返回');
const dup = 本地生成ClashYAML('vless://u1@1.1.1.1:443?security=none&type=tcp#A\nvless://u2@2.2.2.2:443?security=none&type=tcp#A', {});
A(dup.includes('"A"') && dup.includes('"A (2)"'), '重名去重');

process.exit(failed ? 1 : 0);
