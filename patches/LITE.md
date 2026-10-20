# et-lite.js —— 极简版 Worker（免费计划 CPU 优化）

## 为什么要它

CF 免费计划单请求 CPU 上限 10ms。全量版 `_worker.js`（33k 行）的隧道热路径每个字节都要经过
Grain 合包、双层队列、config_JSON 读取等多层 JS 处理，大流量下载（brew/curl 大文件）
几十秒就会烧穿配额 → 会话被 CF 杀死 → `curl (18)` 断流（已实测：24h 内 100+ 次超限告警）。

`et-lite.js`（~345 行）只保留你实际使用的功能，转发路径压到协议下限：

```
ws message → 直接 remote.writable.write()（await 即背压）
remote readable → 直接 server.send()（大帧一次拷贝）
```

| | 全量版 | lite |
|---|---|---|
| 代码量 | 5.1 MB / 33241 行 | ~15 KB / 345 行 |
| 每字节 JS 处理层数 | Grain 合包+队列+分帧 | 1 次拷贝 |
| 每连接额外开销 | KV 读 config、双重哈希、UA 嗅探 | 缓存的 UUID 比对 |
| 隧道功能 | WS/XHTTP/gRPC × vless/trojan/ss | 仅 VLESS+WS（TCP） |
| 订阅 | admin/KV/优选API/SUBAPI | 本地 &clash YAML / &b64 |

## 迁移步骤（10 分钟）

### 1. 保持环境变量不变（TOKEN 不会变）

lite 的身份算法与全量版一致：`userID = UUID 或 MD5MD5(ADMIN+KEY) 推导`，
`订阅TOKEN = MD5MD5(host + userID)`。**现有订阅地址原样可用。**

### 2. 部署

CF 控制台 → 你的 Worker → 编辑器清空 → 粘贴 `et-lite.js` → 保存并部署。

环境变量（与全量版相同的那批直接留着，lite 不认识的会被忽略）：

| 变量 | 必需 | 说明 |
|---|---|---|
| `UUID` | 建议 | 标准 v4；不设则从 ADMIN+KEY 推导 |
| `ADMIN` / `KEY` | 建议 | 沿用现有值 |
| `HOST` | 若与 Worker 域名不同才设 | 参与 TOKEN 计算 |
| `ADD` | 可选 | 优选节点 `ip:port#备注`，逗号/换行分隔 |
| `PROXYIP` | 可选 | 直连失败兜底（不设=纯直连） |
| `PATH` | 可选 | WS 路径，默认 `/` |
| `SUBNAME` | 可选 | 订阅文件名 |
| `DEBUG` | 可选 | `true` 输出隧道日志（wrangler tail 可见） |

### 3. 验证

```bash
# 订阅（TOKEN 不变）
curl -sk "https://你的域名/sub?token=<TOKEN>&clash" | head -5
# 应看到 "# edgetunnel-lite ... 本地生成"

# 隧道：OpenClash 换用该订阅后直接测速；或
npx wrangler tail   # 部署后开着，另开终端 curl 大文件，看 [open]/[close]
```

OpenClash 订阅地址不变：`https://你的域名/sub?token=<TOKEN>&clash`（无需任何转换选项）。

## 与全量版共存

- 全量版仍留在 `main` 的 `_worker.js`（含 [本地补丁]），随时可回切；
- 建议 lite 先部署为**第二个 Worker + 第二个自定义域名**并行观察一周，
  稳定后再把主域名切过来（避免单点试验）。
- 免费版每天 10 万请求内，两个 Worker 并存无成本。

## 已知限制（有意为之）

- 不支持 UDP/DNS 转发（OpenClash 走 fake-ip + 本地解析，日常无感；
  个别需要代理侧 UDP 的应用会直连失败）
- 不支持 trojan/ss/xhttp/grpc —— 你的场景不需要
- 无 admin 面板：改配置 = 改环境变量 + 重新部署（个人自用反而更可预测）
- 队列无上限保护之外的智能调度：极端网络下断链重连，而不是堆积

## CPU 预期（诚实版）

lite 把每字节成本压到约"一次 memcpy + 一次 WS 帧封装"，粗算比全量版省 1~2 个数量级，
但 10ms/请求 的免费墙意味着**单个会话累计 CPU 仍会在长时间满速下载中途触顶**——
lite 能显著推迟断点（几十 MB → 数百 MB 级），不能保证无限。
若一周后仍偶发 `curl (18)` + 超限邮件，那就是免费墙本身，升级 Paid（$5/月）或按 LITE 思路
给下载走 DIRECT 分流。

## 测试

```bash
node patches/test-lite.mjs    # 25 项断言：协议/TOKEN/订阅/1MB 隧道 E2E
node patches/test-clash-yaml.mjs  # 全量版补丁的回归测试
```
