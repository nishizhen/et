# 本地补丁：Clash YAML 本地生成（零第三方订阅转换）

## 背景

上游 edgetunnel 2.1.x 对 `?clash` 订阅请求不本地生成 Clash 配置，而是把
`真实域名 + 当日订阅 TOKEN` 拼进 URL 发给外部转换服务（默认 `SUBAPI.cmliussss.net`）。
这与本项目"个人自用、零第三方依赖、零信息泄漏"的目标冲突。

本补丁让 Worker **本地**把已生成的 vless/trojan 链接转换为 Clash Meta YAML，
彻底移除对 SUBAPI 的依赖。

## 补丁内容（`_worker.js` 中共 3 处，搜索 `[本地补丁]`）

1. **订阅类型路由**：`订阅类型 === 'clash'` 时走本地 mixed 链接生成分支，
   不再落入 `else { // 订阅转换 }` 的外部 SUBAPI 请求分支。
2. **输出层**：在热补丁区之前，将链接列表转换为 Clash YAML 并设置
   `content-type: application/x-yaml`。
3. **新增函数 `本地生成ClashYAML()`**（位于 `Clash订阅配置文件热补丁` 之前）：
   - 解析 `vless://` 与 `trojan://` 链接（uuid/password、tls、sni、fp、alpn、ws path/host、IPv6、URL 编码备注、重名去重）
   - 输出 `proxies` + `节点选择(select)` + `自动选择(url-test)` + 基础 `rules`（LAN/CN 直连，其余走节点选择）
   - 无匹配链接时原样返回（安全回退）

## 使用方法

OpenClash 订阅地址：

```
https://你的域名/sub?token=<TOKEN>&clash
```

- **取消勾选** "Subscribe Convert Online"（不再需要任何转换，本地或在线都不需要）
- OpenClash 侧建议开启"不使用托管的节点/规则/GeoData 文件"，让分组/DNS 由 OpenClash 覆写注入

验证：

```bash
curl -sk "https://你的域名/sub?token=<TOKEN>&clash" | head -20
# 应看到 "proxies:" 开头的 YAML，第一行注释含 "[本地补丁]"
```

## 与上游同步（重要）

本补丁基于 upstream commit `a8ab111`（Version 2026-10-08 22:23:27）。
每次升级上游后需重放补丁：

```bash
git fetch upstream
git checkout main
git rebase upstream/main        # _worker.js 必然冲突
git checkout --theirs _worker.js  # 取上游新版
git apply patches/local-clash-yaml.patch || {
  echo "补丁冲突：按本文件『补丁内容』一节，在新版 _worker.js 中手工重做 3 处 [本地补丁]"
}
git add _worker.js && git rebase --continue
```

若 `git apply` 失败（上游改了订阅生成区上下文），按上文 3 处说明手工移植即可，
每处都很小。移植后运行补丁目录下的单元自测：

```bash
node patches/test-clash-yaml.mjs
```

## 已知取舍

- 只支持 vless/trojan 链接转 Clash（本项目固定使用 vless+ws+tls，ss 走原逻辑）
- `udp: true` 固定输出（CF 隧道支持 UDP；若上游协议变更需同步调整）
- 规则极简（CN 直连 + 其余代理），GeoSite/规则集由 OpenClash 覆写负责
