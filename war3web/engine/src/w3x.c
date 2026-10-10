// w3x.c — Warcraft III 地图（.w3x/.w3m）读取。
// 地图本质是带 W3X 头的 MPQ 归档：用 StormLib（MIT，MPQ 标准库）打开，
// 内部文件如 war3map.w3i（地图信息）、war3map.w3e（地形）、war3map.j（脚本）。
// 浏览器/wasm 场景：JS 先写入 Emscripten 虚拟文件系统（FS），StormLib 按路径打开。
#include <stdint.h>
#include <string.h>
#include <StormLib.h>

// ============================================================================
// 头部校验（不依赖 StormLib 的轻量入口）
// ============================================================================

static int magic_ok(const uint8_t* b, int len) {
  if (len < 4) return 0;
  return (b[0] == 'W' && b[1] == '3' && b[2] == 'X' && b[3] == '!') ||
         (b[0] == 'W' && b[1] == '3' && b[2] == 'M' && b[3] == '!');
}

// 校验 buf 是否为合法的 W3X/W3M 头部（magic 匹配且长度足够）。返回 1 = 合法。
int w3x_check_header(const uint8_t* buf, int len) {
  return (magic_ok(buf, len) && len >= 8) ? 1 : 0;
}

// 读出版本号（小端 int32，偏移 4）。buf 不足 8 字节返回 -1。
int w3x_get_version(const uint8_t* buf, int len) {
  if (len < 8) return -1;
  return (int)(buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24));
}

// ============================================================================
// 地图归档（StormLib / MPQ）
// ============================================================================

static HANDLE g_hMpq = NULL;
static char g_map_path[512];

// 打开虚拟文件系统中的地图（JS 先用 FS.writeFile 写入）。成功返回 1，失败 0。
int w3x_open(const char* path) {
  if (g_hMpq) { SFileCloseArchive(g_hMpq); g_hMpq = NULL; }
  if (path == NULL) return 0;
  if (!SFileOpenArchive(path, 0, MPQ_OPEN_READ_ONLY, &g_hMpq)) return 0;
  strncpy(g_map_path, path, sizeof(g_map_path) - 1);
  g_map_path[sizeof(g_map_path) - 1] = '\0';
  return 1;
}

// 关闭地图。返回 1 若确实关过。
int w3x_close(void) {
  if (g_hMpq) {
    SFileCloseArchive(g_hMpq);
    g_hMpq = NULL;
    return 1;
  }
  return 0;
}

// 地图内部是否存在指定文件（如 "war3map.w3i"）。返回 1/0。
int w3x_has_file(const char* name) {
  if (!g_hMpq || name == NULL) return 0;
  HANDLE hFile;
  if (!SFileOpenFileEx(g_hMpq, name, SFILE_OPEN_FROM_MPQ, &hFile)) return 0;
  SFileCloseFile(hFile);
  return 1;
}

// 读取地图内部文件到 out（maxlen 上限）。
// 返回 >0 = 读到的字节数；-1 地图未打开；-2 文件不存在或超出上限；-3 读取失败。
int w3x_read(const char* name, uint8_t* out, int maxlen) {
  if (!g_hMpq || name == NULL || out == NULL) return -1;
  HANDLE hFile;
  if (!SFileOpenFileEx(g_hMpq, name, SFILE_OPEN_FROM_MPQ, &hFile)) return -2;
  DWORD size = SFileGetFileSize(hFile, NULL);
  if (size == 0 || (int)size > maxlen) {
    SFileCloseFile(hFile);
    return -2;
  }
  DWORD read = 0;
  int ok = SFileReadFile(hFile, out, size, &read, NULL);
  SFileCloseFile(hFile);
  return ok ? (int)read : -3;
}