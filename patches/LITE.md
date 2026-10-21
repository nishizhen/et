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
| 代码量 | 5.1 MB / 33241 行 | ~17 KB / 369 行 |
| 下行 WS 帧 | 32KB Grain 合包 | 32KB 合包（0ms 宏任务批处理，实测 4MB=129 帧） |
| 每连接额外开销 | KV 读 config、双重哈希、UA 嗅探 | 缓存的 UUID 比对 |
| 隧道功能 | WS/XHTTP/gRPC × vless/trojan/ss | 仅 VLESS+WS（TCP） |
| 订阅 | admin/KV/优选API/SUBAPI | 本地 &clash YAML / &b64 |
| 特征码防护 | 字符串拆分/atob/2MB 希伯来文填充 | 字符串拆分+转义（明文 0 处 vless/edgetunnel/cloudflare:sockets） |

## 迁移步骤（10 分钟）

### 1. 保持环境变量不变（TOKEN 不会变）

lite 的身份算法与全量版一致：`userID = UUID 或 MD5MD5(ADMIN+KEY) 推导`，
`订阅TOKEN = MD5MD5(host + userID)`。**现有订阅地址原样可用。**

### 2. 部署

CF 控制台 → 你的 Worker → 编辑器清空 → 粘贴 `et-lite.js` → 保存并部署。

环境变量（与全量版相同的那批直接留着，lite 不认识的会被忽略）：

| 变量 | 必需 | 说明 |
|---|---|---|
| `UUID` | ✅ 必填 | 标准 v4；不设则从 ADMIN+KEY 推导 |
| `ADMIN` / `KEY` | 仅回退全量版时需要 | lite 设了 UUID 后不读取二者；与全量版共用以保持 TOKEN 一致时沿用现有值 |
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

## 优选 IP 与 PROXYIP 的正确理解（常见误区）

**误区 1："不配 ADD 也行，mihomo 有 CF IP 库会自动优选"** —— 不对。
mihomo 的 `url-test` 只会测**订阅里已有的节点**并在其中切换，它没有、也不会生成
任何 CF IP 库。不配 `ADD` 时你的订阅只有 1 个"主节点"（你的域名，DNS 随机落到某个
CF 边缘 IP），url-test 无事可做。IP 库只能来自你自己填入的 `ADD`。
- 不配 ADD = 能用（域名直连 CF Anycast，多数时候没问题），但没有备选
- 配 ADD = 你实测过的 5~10 个 IP，url-test 在其中自动切换，这才是"优选"

**误区 2："不配 PROXYIP 直连，CF 的网站是不是访问不了"** —— 混淆了两段链路。
- 你的设备 → Worker：走 WS(TLS) 到你的自定义域名，与 PROXYIP 无关
- Worker → 目标网站（GitHub 等）：所谓"直连"。PROXYIP 只在**目标站拉黑
  Cloudflare 出口 IP 段**时才有用（少数站点），把流量转给一个第三方代理服务
  换取非 CF 源 IP。访问 CF 自家站点完全不需要它。
- 不设 `PROXYIP` 的 lite = 纯直连，零第三方；对"所有目标站都走代理"的需求
  不适用（那是反代场景，本方案本来也不是）

**配置方法**：用本目录的测速脚本 [`cf-bestip.sh`](./cf-bestip.sh)，在
**使用代理的那台设备所在网络**（OpenWrt SSH / Mac / Linux 均可）运行：

```sh
sh cf-bestip.sh 你的域名              # 默认：40 个候选，取最快 8 个，443 端口
sh cf-bestip.sh 你的域名 60 10 8443   # 60 候选、取 10 个、测 8443 端口
```

脚本原理：从 CF 官方 IPv4 网段随机取候选 IP，以**你的域名做 SNI** 发起 TLS 握手 +
一次 `/version` 小请求（与生产链路完全一致，测的就是真实质量），按握手耗时排序。
每批 10 路并发防弱网自拥塞，有效结果不足时自动串行慢速重试；偶发"全部失败"多为
网络瞬时抖动，隔几分钟重跑一次即可（脚本在 OpenWrt BusyBox ash 与 macOS/Linux
POSIX sh 下均可运行）。
**输出最后一行整行复制进 CF 环境变量 `ADD` 即可**，格式已经是 lite 要的：

```
162.158.230.165:443#CF-1, 188.114.111.236:443#CF-2, 104.27.6.180:443#CF-3, ...
```

改完环境变量重新部署即生效，订阅里自动多出这些节点；日常切换由 mihomo
`url-test` 自动完成，建议一两个月重跑一次脚本复核 IP 清单。
多端口都值得测（443/8443/2053/2083/2087/2096），结果可合并进同一个 `ADD`
（换行分隔即可）。

## 已知限制（有意为之）

- 不支持 UDP/DNS 转发（OpenClash 走 fake-ip + 本地解析，日常无感；
  个别需要代理侧 UDP 的应用会直连失败）
- 不支持 trojan/ss/xhttp/grpc —— 你的场景不需要
- 无 admin 面板：改配置 = 改环境变量 + 重新部署（个人自用反而更可预测）
- 无竞速拨号/连接世代管理等调度层：极端网络下断链重连（重连对单用户几乎无感）
- 下行合包用 0ms 宏任务批处理：慢流场景每帧多 1 个事件循环轮（亚毫秒级），
  换取快流场景 8 倍帧数削减（免费计划 CPU 收益远大于该开销）

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
