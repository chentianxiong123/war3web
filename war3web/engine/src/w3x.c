// w3x.c — Warcraft III 地图（.w3x/.w3m）文件头解析。
// 头部布局（Blizzard 格式）：magic(4) + version(4, LE) + flags(4, LE) ...
// .w3x 魔数 "W3X!"，.w3m 魔数 "W3M!"。这是引擎读地图的入口。
#include <stdint.h>

static int magic_ok(const uint8_t* b, int len) {
  if (len < 4) return 0;
  return (b[0] == 'W' && b[1] == '3' && b[2] == 'X' && b[3] == '!') ||
         (b[0] == 'W' && b[1] == '3' && b[2] == 'M' && b[3] == '!');
}

// 校验 buf 是否为合法的 W3X/W3M 头部（magic 匹配且长度足够）。
// 返回 1 = 合法，0 = 不合法。
int w3x_check_header(const uint8_t* buf, int len) {
  return (magic_ok(buf, len) && len >= 8) ? 1 : 0;
}

// 读出版本号（小端 int32，偏移 4）。buf 不足 8 字节返回 -1。
int w3x_get_version(const uint8_t* buf, int len) {
  if (len < 8) return -1;
  return (int)(buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24));
}
