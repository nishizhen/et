# 🚀 et —— edgetunnel 个人自用精简版

本仓库 fork 自 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)（AGPL-3.0 开源，
上游版权与免责条款见原文），在其基础上针对 **个人自用 + OpenClash + Cloudflare 免费计划**
场景做了两项关键改造，并提供一个极简替代版 Worker。

> 仅供个人学习研究使用，请遵守当地法律法规与 Cloudflare 服务条款。

---

## 为什么需要这个版本？

上游全量版功能非常强大（admin 面板、KV、多协议、优选生成器……），但对"一个人挂个
订阅在 OpenClash 上用"的场景，有两个绕不开的问题：

1. **第三方依赖 = 信息泄漏**：`?clash` 订阅会把你的 **域名 + 当日订阅 TOKEN** 发给
   公共转换服务（SUBAPI.cmliussss.net）；不配 `PROXYIP` 时兜底反代也指向作者的服务。
2. **免费计划 CPU 墙**：全量版隧道热路径较重，大文件下载（`brew upgrade` 等）
   几十秒即触发 CF 免费计划单请求 CPU 上限 → 会话被杀、下载中途断流
   （实测 24 小时可收到 100+ 次超限告警）。

## 本仓库提供什么

| 文件 | 是什么 | 适合谁 |
|---|---|---|
| **`et-lite.js`** ⭐推荐 | 极简 Worker（~370 行）：只保留 VLESS+WS 隧道、本地订阅生成、落地页 | 单人自用、OpenClash、在意 CPU 超限/第三方依赖的人 |
| `_worker.js` | 上游最新版 + **本地 Clash YAML 补丁**（`?clash` 不再请求 SUBAPI） | 需要 admin 面板/多协议/完整功能的人 |
| `patches/` | 补丁文件、迁移文档、测速脚本、回归测试 | 二者皆可 |

旧版（混淆产物 + 明文备份）保留在分支 `backup/legacy-20250830`。

## et-lite 与上游全量版的差异

| | 全量版 | et-lite |
|---|---|---|
| 代码量 | 5.1 MB / 33k 行 | ~17 KB |
| 订阅链路 | 默认经 SUBAPI 转换（泄漏域名+TOKEN） | **纯本地生成** `&clash` YAML / `&b64`，零第三方 |
| 反代 | 默认兜底指向作者 ProxyIP 服务 | **纯直连**；`PROXYIP` 可选自配 |
| 优选 IP | 每次订阅拉 GitHub CIDR | 你自测的 `ADD` 环境变量（附测速脚本） |
| 大文件 CPU | Grain 多层队列 | 32KB 合包 + 单次拷贝，帧数降 8 倍 |
| 特征码防护 | 字符串拆分/atob | 同等拆分（明文 0 处敏感词） |
| admin 面板 / KV / XHTTP / gRPC / trojan / ss / ECH / TLS分片 / UDP / TG / 测速API | ✅ | ❌（有意删除，见取舍） |
| TOKEN 算法 | MD5MD5(host+userID) | **一致**，订阅地址可直接迁移 |

**取舍**：lite 没有面板——改配置 = 改环境变量 + 重新部署；不支持 UDP/DNS 隧道
（OpenClash fake-ip 模式下无感）。若你需要多协议、多用户或可视化后台，请用本仓库的
`_worker.js`（含 Clash 本地补丁），或直接用上游。

## 快速开始（et-lite）

1. **部署**：CF Workers 新建/编辑 Worker → 粘贴 [`et-lite.js`](./et-lite.js) → 部署，
   绑定自定义域名。
2. **环境变量**：

   ```
   UUID    = 你的标准 UUIDv4（节点身份）
   ADMIN   = 后台密码（不设 UUID 时参与推导，建议独立强随机）
   KEY     = 强随机（务必设置，默认值公开在源码里）
   ADD     = 可选，优选 IP 清单，见下
   DEBUG   = 可选，true 输出隧道日志（wrangler tail 可见）
   ```

3. **优选 IP**（可选但推荐）：在 OpenClash 所在网络运行
   [`patches/cf-bestip.sh`](./patches/cf-bestip.sh)：

   ```sh
   sh cf-bestip.sh 你的域名     # 输出最后一行整行复制进 ADD 环境变量
   ```

4. **OpenClash 订阅地址**：

   ```
   https://你的域名/sub?token=<TOKEN>&clash
   ```

   取消勾选"在线订阅转换"（Worker 直接返回成品 YAML）。
   想要裸链接列表则用 `&b64`。TOKEN 用本地工具算出（纯离线，算法与 Worker 一致）：

   ```sh
   node patches/et-token.cjs 你的域名 --uuid <你的UUID>
   # 或不设 UUID：node patches/et-token.cjs 你的域名 --admin <ADMIN> --key <KEY>
   ```

5. **验证**：`curl -sk "https://域名/sub?token=<TOKEN>&clash" | head -5`
   应看到 `# edgetunnel-lite ... 本地生成` 开头的 YAML。

详细迁移说明、误区澄清（mihomo 没有 IP 库、PROXYIP 的真实用途）、CPU 预期：
👉 [patches/LITE.md](./patches/LITE.md)

## 全量版 + Clash 补丁的用法

适合保留完整功能但拒绝 SUBAPI 的人：部署 `_worker.js`（本仓库版本），订阅地址
`/sub?token=<TOKEN>&clash` 即由 Worker 本地生成 Clash YAML。升级上游后重放补丁的
步骤见 [patches/LOCAL-CLASH-YAML.md](./patches/LOCAL-CLASH-YAML.md)。

## 测试与回归

```sh
node patches/test-lite.mjs        # et-lite：协议/订阅/隧道 E2E 25 项
node patches/test-clash-yaml.mjs  # 全量版 Clash 补丁 11 项
```

## 与上游同步

```sh
git fetch upstream && git rebase upstream/main
# _worker.js 冲突时取上游新版，再按 patches/LOCAL-CLASH-YAML.md 重放
```

## 致谢与许可

- 原始项目与主要功能：[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)（AGPL-3.0）
- 本仓库的修改（et-lite、Clash 本地补丁、测速脚本）同样以 AGPL-3.0 开源
- 上游的免责声明同样适用：本项目仅供教育、研究和安全测试目的
