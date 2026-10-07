// MPQ 读取器 - 导出给 JS 调用的 WASM 接口
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "StormLib.h"

// 全局: 当前打开的 MPQ
static HANDLE g_hMpq = NULL;
static char *g_buf = NULL;
static DWORD g_bufSize = 0;

// 打开 MPQ (文件名, 从 emscripten 虚拟文件系统读)
int mpq_open(const char *path) {
    if (g_hMpq) { SFileCloseArchive(g_hMpq); g_hMpq = NULL; }
    if (SFileOpenArchive(path, 0, 0, &g_hMpq)) {
        return 1;
    }
    return 0;
}

// 列出文件数 (需要 listfile)
int mpq_file_count(void) {
    if (!g_hMpq) return -1;
    // 遍历文件
    SFILE_FIND_DATA fd;
    HANDLE hFind = SFileFindFirstFile(g_hMpq, "*", &fd, NULL);
    int count = 0;
    if (hFind) {
        do { count++; } while (SFileFindNextFile(hFind, &fd));
        SFileFindClose(hFind);
    }
    return count;
}

// 读取文件到内部缓冲, 返回大小
int mpq_read(const char *path) {
    if (!g_hMpq) return -1;
    HANDLE hFile = NULL;
    if (SFileOpenFileEx(g_hMpq, path, SFILE_OPEN_FROM_MPQ, &hFile)) {
        DWORD size = SFileGetFileSize(hFile, NULL);
        if (g_buf) free(g_buf);
        g_buf = malloc(size + 1);
        DWORD read = 0;
        SFileReadFile(hFile, g_buf, size, &read, NULL);
        g_bufSize = read;
        SFileCloseFile(hFile);
        return (int)read;
    }
    return -1;
}

// 获取内部缓冲指针 (JS 通过 _g_buf 或此函数访问)
char *mpq_get_buf(void) { return g_buf; }
int mpq_get_buf_size(void) { return (int)g_bufSize; }

// 测试入口 (node 直接跑)
int main(int argc, char **argv) {
    if (argc < 2) { printf("usage: mpq <file>\n"); return 1; }
    printf("opening %s\n", argv[1]);
    if (mpq_open(argv[1])) {
        int n = mpq_file_count();
        printf("file_count = %d\n", n);
        // 读 (listfile) 前 200 字节
        int s = mpq_read("(listfile)");
        printf("listfile size = %d\n", s);
        if (s > 0) {
            g_buf[s] = 0;
            printf("first line: %.100s\n", g_buf);
        }
        return 0;
    }
    printf("open failed\n");
    return 1;
}
