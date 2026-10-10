// math.c — vec3 基础运算（引擎数学库起步）。
// 导出为平面函数（float 标量/指针参数），避免 struct by-value 的 wasm ABI 差异。
#include <math.h>

// |v| = sqrt(x^2 + y^2 + z^2)
float vec3_lenf(float x, float y, float z) {
  return sqrtf(x * x + y * y + z * z);
}

// a·b = ax*bx + ay*by + az*bz
float vec3_dotf(float ax, float ay, float az, float bx, float by, float bz) {
  return ax * bx + ay * by + az * bz;
}

// out = a×b（调用方提供 3 个 float 的缓冲区）
void vec3_crossf(float ax, float ay, float az, float bx, float by, float bz, float* out) {
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
}
