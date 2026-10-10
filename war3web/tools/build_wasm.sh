#!/usr/bin/env bash
# M1 构建链封装：emcmake + cmake -G Ninja → war3core.{js,wasm}
# 用法（WSL 内）：bash tools/build_wasm.sh
#   项目在 /mnt/z 也没关系：构建产物默认放 WSL 本地 ~/war3web-build，
#   只有最终产物拷贝回 wasm/out（避免 NFS 跨文件系统拖慢编译）。
# 环境变量：WASM_BUILD_DIR 覆盖构建目录；SKIP_COPY=1 不拷回项目。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${WASM_BUILD_DIR:-$HOME/war3web-build}"
OUT="$ROOT/wasm/out"

# 加载 emsdk 环境（优先当前 shell 已有 emcc）
if ! command -v emcc >/dev/null 2>&1; then
    # WSL1 坑：PATH 里 python3 可能是 Windows 的 Python（/usr/local/bin 优先），
    # emsdk 会因此按 Windows 平台下载工具链、emcc 也无法执行。
    # 钉死为 Linux python 并前置 /usr/bin。
    export EMSDK_PYTHON=/usr/bin/python3.10
    export PATH="/usr/bin:$PATH"
    if [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
        # shellcheck disable=SC1091
        source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
    else
        echo "错误: 找不到 emcc，也未找到 ~/emsdk/emsdk_env.sh" >&2
        exit 1
    fi
fi

echo "== emcc: $(emcc --version | head -1)"
mkdir -p "$BUILD" "$OUT"

emcmake cmake -G Ninja -S "$ROOT/wasm" -B "$BUILD" >/dev/null
cmake --build "$BUILD"

if [ "${SKIP_COPY:-0}" != "1" ]; then
    cp "$BUILD/war3core.js" "$BUILD/war3core.wasm" "$OUT/"
    echo "== 产物: $OUT/war3core.js + war3core.wasm"
else
    echo "== 产物: $BUILD/war3core.js + war3core.wasm（未拷贝）"
fi