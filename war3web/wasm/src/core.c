/*
 * war3core — M1 最小 WASM 核心（C）
 * 目标：验证 Emscripten + CMake 构建链，在 Node 与浏览器双端加载。
 * 内容：纯计算内核（add/multiply/fib），后续 M3/M4 把 JASS VM 与模拟层搬进来。
 */
#include <stdint.h>

/* 加法 */
int32_t add(int32_t a, int32_t b) {
    return a + b;
}

/* 乘法 */
int32_t multiply(int32_t a, int32_t b) {
    return a * b;
}

/* 第 n 个斐波那契数（迭代，避免递归爆栈），测循环/较大计算 */
int32_t fib(int32_t n) {
    int32_t a = 0, b = 1, t;
    if (n <= 0) return 0;
    for (int32_t i = 1; i < n; ++i) {
        t = a + b;
        a = b;
        b = t;
    }
    return b;
}