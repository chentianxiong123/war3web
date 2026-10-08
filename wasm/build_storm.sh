#!/bin/bash
# StormLib → WASM 批量编译 v2 (容错版)
cd /home/a1/wasm_demo/c/StormLib
OUT=/home/a1/wasm_demo/wasm
rm -f $OUT/*.o $OUT/*.a
mkdir -p $OUT

CFLAGS="-I src -I src/adpcm -I src/bzip2 -I src/huffman -I src/jenkins -I src/libtomcrypt/src/headers -I src/libtommath -I src/lzma/C -I src/pklib -I src/sparse -I src/zlib -O2 -fno-exceptions -fno-rtti"

compile_one() {
  local f="$1"
  local name=$(basename "${f%.*}")
  # 跳过 Windows 专属文件
  case "$name" in
    DllMain|Threads|sources-*|Threads) return ;;
  esac
  emcc -c "$f" $CFLAGS -o "$OUT/$name.o" 2>/dev/null
  if [ -f "$OUT/$name.o" ]; then
    echo "  OK: $name.o"
  else
    echo "  FAIL: $name ($f)"
  fi
}

echo "=== 编译 C 文件 ==="
for f in $(find src -maxdepth 1 -name '*.c'); do compile_one "$f"; done
for f in $(find src/bzip2 src/jenkins src/pklib src/adpcm src/huffman src/sparse -name '*.c'); do compile_one "$f"; done
for f in $(find src/zlib -name '*.c'); do compile_one "$f"; done
# lzma: 排除 Threads.c
for f in $(find src/lzma/C -name '*.c' ! -name 'Threads.c'); do compile_one "$f"; done
# libtomcrypt 全部 (排除 windows 专属)
for f in $(find src/libtomcrypt -name '*.c'); do compile_one "$f"; done

echo "=== 编译 C++ 主文件 ==="
for f in src/*.cpp; do compile_one "$f"; done

echo "=== 打包静态库 ==="
cd $OUT
emar rcs libstorm_wasm.a *.o
echo "对象数: $(ls *.o | wc -l)"
ls -la libstorm_wasm.a
