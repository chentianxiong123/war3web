// 压缩方向 stub - 我们只需要解压, 压缩功能在浏览器端用不到
#include <stddef.h>

// LZMA 压缩 stub
typedef struct { void *p; } CLzmaEncHandle;
int LzmaEncProps_Init(void *p) { return 0; }
int LzmaEncode(void *p, unsigned char *dest, size_t *destLen, const unsigned char *src, size_t srcLen, const void *props, void *propsEncoded, size_t *propsSize, int writeEndMark, void *allocFuncs, void *allocBigFuncs) { return 0; }
int LzmaEnc_MemEncode(void *p, unsigned char *dest, size_t *destLen, const unsigned char *src, size_t srcLen, void *props, size_t *propsSize, int writeEndMark, void *allocFuncs, void *allocBigFuncs) { return 0; }
void *LzmaEnc_Create(void *allocFuncs) { return NULL; }
void LzmaEnc_Destroy(void *p, void *allocFuncs, void *allocBigFuncs) {}
void LzmaEncProps_Normalize(void *p) {}

// BZIP2 压缩 stub
void BZ2_compressBlock(void *s, unsigned char *block, int nblock, int verbosity, int small, unsigned int workFactor) {}
int BZ2_bzCompressInit(int *strm, int blockSize100k, int verbosity, int workFactor) { return 0; }
int BZ2_bzCompress(int *strm, int action) { return 0; }
int BZ2_bzCompressEnd(int *strm) { return 0; }
