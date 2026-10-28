#!/usr/bin/env bash
# dsh-relay 双副本同步
#
# 背景：profile 的 package.json 写 "dsh-relay": "file:vendor/dsh-relay"，
# 但 pnpm 把它【复制】成 node_modules/dsh-relay（实体目录，不是软链）。
# DSH 运行时加载 node_modules/ 那份 —— 只改 vendor/ 不生效。
#
# 用法：
#   bash scripts/sync.sh          # vendor → node_modules + 热重载
#   bash scripts/sync.sh back     # 反向
#   bash scripts/sync.sh diff     # 只看差异

set -euo pipefail

PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"
V="$PROFILE/vendor/dsh-relay"
N="$PROFILE/node_modules/dsh-relay"
HOST="${DSH_GUI_URL:-http://127.0.0.1:8546}"

MODE="${1:-forward}"

echo "=== 副本状态 ==="
for f in lib/index.js lib/session-ops.js lib/session-flags.js; do
  vf="$V/$f"; nf="$N/$f"
  [ -f "$vf" ] && vs=$(stat -c%s "$vf") || vs="-"
  [ -f "$nf" ] && ns=$(stat -c%s "$nf") || ns="-"
  if [ "$vs" = "$ns" ]; then echo "  ✅ $f ($vs B)"; else echo "  ⚠️  $f vendor=$vs node_modules=$ns"; fi
done

if [ "$MODE" = "diff" ]; then
  echo ""
  diff "$V/lib/index.js" "$N/lib/index.js" | head -40 || true
  exit 0
fi

if [ "$MODE" = "back" ]; then SRC="$N"; DST="$V"; LABEL="node_modules → vendor"
else SRC="$V"; DST="$N"; LABEL="vendor → node_modules"; fi

echo ""
echo "=== 同步 $LABEL ==="
STAMP=$(date +%Y%m%d-%H%M%S)
for f in lib/index.js lib/session-ops.js lib/session-flags.js lib/measure.js lib/client.js; do
  sf="$SRC/$f"; df="$DST/$f"
  [ -f "$sf" ] || continue
  if [ -f "$df" ] && cmp -s "$sf" "$df"; then echo "  $f 无变化"; continue; fi
  [ -f "$df" ] && cp "$df" "$df.bak-$STAMP"
  cp "$sf" "$df"
  echo "  ✅ $f"
done

echo ""
echo "=== 热重载 ==="
curl -s --noproxy "*" --max-time 25 -X POST "$HOST/dsh-relay/hotswap" | head -c 120 || echo "  （热重载失败，可能端口不对）"
echo ""
