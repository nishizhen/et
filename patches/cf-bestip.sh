#!/bin/sh
# =============================================================================
# cf-bestip.sh —— Cloudflare 优选 IP 测速（输出可直接粘贴到 lite 的 ADD 环境变量）
#
# 原理：从 CF 官方 IPv4 网段随机生成候选 IP，以【你的域名做 SNI】发起 TLS 握手 +
#       一次 /version 小请求，测量本机到各 CF 边缘节点的真实链路质量；
#       与生产链路（OpenClash → 优选IP → 你的域名）完全一致，测的就是它。
#
# 用法（在【使用代理的那台设备所在网络】跑：OpenWrt SSH / Mac / Linux 均可）：
#   sh cf-bestip.sh <你的Worker域名> [候选数=40] [保留前N=8] [端口=443]
#
# 示例：
#   sh cf-bestip.sh et.example.com            # 40 个候选，取最快 8 个，443
#   sh cf-bestip.sh et.example.com 60 10 8443 # 换 8443 端口再测一组
#
# 说明：
#   - 本机直连测 CF，不经过代理（脚本会自动临时清掉代理环境变量）
#   - 依赖 curl（OpenWrt 装了 OpenClash 就有）
#   - 并发分批（每批 10 路）防弱网自拥塞；结果不足时自动串行慢速重试
#   - 结果一屏：注释行是实测数据，最后一行整行复制进 CF 环境变量 ADD 即可
#   - mihomo 的 url-test 会在此后持续自动优选，本脚本只负责提供初始 IP 库
#   - 网络抖动导致的偶发"全部失败"，隔几分钟重跑一次即可
# =============================================================================
DOMAIN="$1"; N="${2:-40}"; TOP="${3:-8}"; PORT="${4:-443}"
[ -n "$DOMAIN" ] || { echo "用法: $0 <Worker域名> [候选数] [保留前N] [端口]"; exit 1; }
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

# CF 官方 IPv4 网段（在线刷新自 cloudflare.com，失败用内置表）
CIDRS=$(curl -s -m 8 https://www.cloudflare.com/ips-v4/ 2>/dev/null | tr '\n' ' ')
[ -n "$CIDRS" ] || CIDRS="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14"

_rand16() { # 16bit 随机数：优先 /dev/urandom（POSIX od -d），退回 $RANDOM
	_v=$(od -An -N2 -d /dev/urandom 2>/dev/null | tr -dc '0-9')
	[ -n "$_v" ] || _v=$(( ${RANDOM:-0} % 65536 ))
	echo "${_v:-0}"
}

rand_ip() { # $1 = a.b.c.d/mask
	_ip="${1%%/*}"; _mask="${1##*/}"
	_hb=$((32 - _mask)); [ "$_hb" -gt 0 ] 2>/dev/null || return 1
	# 纯参数展开拆四段，避免污染 IFS
	_o1=${_ip%%.*}; _t=${_ip#*.}
	_o2=${_t%%.*}; _t=${_t#*.}
	_o3=${_t%%.*}; _o4=${_t#*.}
	[ -n "$_o4" ] || return 1
	_base=$(( _o1 * 16777216 + _o2 * 65536 + _o3 * 256 + _o4 ))
	_span=$(( 1 << _hb ))
	_r=$(( $(_rand16) * 65536 + $(_rand16) ))
	_n=$(( _base + _r % _span ))
	echo "$(( _n / 16777216 )).$(( _n / 65536 % 256 )).$(( _n / 256 % 256 )).$(( _n % 256 ))"
}

# 候选 IP 在主进程生成（子 shell 的 $RANDOM 可能同种子）
_NC=$(echo "$CIDRS" | wc -w | tr -d ' ')
_PER=$(( (N + _NC - 1) / _NC ))
IPS=$(for _c in $CIDRS; do _j=0; while [ $_j -lt $_PER ]; do rand_ip "$_c"; _j=$((_j + 1)); done; done | sort -u | head -n "$N")
[ -n "$IPS" ] || { echo "生成候选 IP 失败"; exit 1; }
_CNT=$(echo $IPS | wc -w | tr -d ' ')

TMPD="/tmp/cfbest.$$"; mkdir -p "$TMPD"
TMO=10
echo "域名=$DOMAIN 端口=$PORT 候选=$_CNT 个（每批 10 路并发，超时 ${TMO}s）..."

# ---- 两阶段探测：A=TLS+HTTP200（链路质量） B=WS 101（代理通道可用性） ----
# 只有 A、B 双通过的 IP 才输出——GFW 对部分 CF 冷段的行为是 TLS 能握、WS 被掐，
# 单测 TLS 会选出实际做节点连不上的 IP。
_k=0
for _ip in $IPS; do
	_k=$((_k + 1))
	(
		_o=$(curl -so /dev/null -m $TMO --connect-timeout 8 \
			-w "%{time_appconnect} %{http_code} %{time_total}" \
			--resolve "$DOMAIN:$PORT:$_ip" "https://$DOMAIN:$PORT/version" 2>/dev/null)
		[ -n "$_o" ] && echo "$_o $_ip" > "$TMPD/r$_k"
		_c=$(curl -sk --http1.1 -o /dev/null -m 8 --connect-timeout 6 \
			-H "Upgrade: websocket" -H "Connection: Upgrade" \
			-H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
			-w "%{http_code}" --resolve "$DOMAIN:$PORT:$_ip" "https://$DOMAIN:$PORT/" 2>/dev/null)
		[ "$_c" = "101" ] && echo "$_ip" > "$TMPD/w$_k"
	) 2>/dev/null &
	[ $(( _k % 10 )) -eq 0 ] && wait
done
wait

# WS 通过名单
cat "$TMPD"/w* 2>/dev/null | sort -u > "$TMPD/wsok"
# 只保留 TLS 成功且 WS 通过的，按握手耗时排序
sort -n "$TMPD"/r* 2>/dev/null | awk '$1 > 0 && $2 == 200' \
	| awk 'NR==FNR{ok[$1];next} ($4 in ok)' "$TMPD/wsok" - > "$TMPD/ranked"
_tlsok=$(sort -n "$TMPD"/r* 2>/dev/null | awk '$1 > 0 && $2 == 200' | wc -l | tr -d ' ')
_wsok=$(wc -l < "$TMPD/wsok" 2>/dev/null | tr -d ' ')
[ "$_tlsok" -gt 0 ] && [ "$_wsok" = "0" ] && echo "⚠️ TLS 全通但 WS 全部被拦：本网络到该 Worker 的 WS 通道异常（检查 Worker 状态/运营商干扰），换端口 8443 或 2053 再试"
_have=$(grep -c . "$TMPD/ranked" 2>/dev/null || echo 0)

# ---- 结果不足：串行慢速重试未成功的候选（逐个来，抗抖动）----
if [ "$_have" -lt "$TOP" ]; then
	echo "有效结果 $_have/$TOP（TLS通 $_tlsok / WS通 $_wsok），串行重试其余候选..."
	for _ip in $IPS; do
		[ "$_have" -ge "$TOP" ] && break
		awk -v ip="$_ip" '$4 == ip { f = 1 } END { exit !f }' "$TMPD/ranked" 2>/dev/null && continue
		_o=$(curl -so /dev/null -m 15 --connect-timeout 10 \
			-w "%{time_appconnect} %{http_code} %{time_total}" \
			--resolve "$DOMAIN:$PORT:$_ip" "https://$DOMAIN:$PORT/version" 2>/dev/null)
		case "$_o" in *" 200 "*) ;; *) continue ;; esac
		_c=$(curl -sk --http1.1 -o /dev/null -m 10 \
			-H "Upgrade: websocket" -H "Connection: Upgrade" \
			-H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
			-w "%{http_code}" --resolve "$DOMAIN:$PORT:$_ip" "https://$DOMAIN:$PORT/" 2>/dev/null)
		[ "$_c" = "101" ] && { echo "$_o $_ip" >> "$TMPD/retry"; echo "$_ip" >> "$TMPD/wsok"; _have=$((_have + 1)); }
	done
	if [ -f "$TMPD/retry" ]; then
		sort -n "$TMPD"/r* "$TMPD/retry" 2>/dev/null | awk '$1 > 0 && $2 == 200' \
			| awk 'NR==FNR{ok[$1];next} ($4 in ok)' "$TMPD/wsok" - > "$TMPD/ranked2" && mv "$TMPD/ranked2" "$TMPD/ranked"
	fi
fi

if [ ! -s "$TMPD/ranked" ]; then
	echo "全部候选失败：请确认 ①域名已部署 Worker ②端口为 CF 支持端口(443/8443/2053/2083/2087/2096) ③本网络可直连 CF"
	echo "网络抖动也会导致偶发全失败，隔几分钟重跑一次；建议在 OpenWrt 路由器上运行（与代理出口一致）"
	rm -rf "$TMPD"; exit 1
fi

echo ""
echo "实测结果（TLS握手 / 请求总耗时）："
head -n "$TOP" "$TMPD/ranked" | awk '{ printf "  %-16s  %ss  %ss\n", $4, $1, $3 }'
echo ""
echo "↓ 整行复制到 Worker 环境变量 ADD："
head -n "$TOP" "$TMPD/ranked" | awk -v p="$PORT" '{ a = a (NR > 1 ? ", " : "") $4 ":" p "#CF-" NR } END { print a }'
rm -rf "$TMPD"
