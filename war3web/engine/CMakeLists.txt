# ============================================================================
# war3engine — war3web 的 C/C++ 引擎（Emscripten 主线）。
# 配置：emcmake cmake -G Ninja -B build-web
# 构建：ninja -C build-web
# 参考 WhiteoutFlakes 的 wasm 配置精神：无异常、编译 -O2、链接 -Oz、
# 禁止内联大函数（规避 Chrome V8 wasm 编译冻结）。
# MPQ 归档解析：StormLib（MIT，MPQ/W3X 标准库，src/ 自包含含 zlib/bzip2）。
# ============================================================================
cmake_minimum_required(VERSION 3.20)
project(war3engine LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---- StormLib（MPQ 归档解析）----
# 只编核心源：主目录 + 压缩/加密子目录；排除 lzma/wdk/sparse/DllMain（平台特定/可选）。
set(STORMLIB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/extern/stormlib/src")
set(STORMLIB_CORE
  ${STORMLIB_DIR}/FileStream.cpp
  ${STORMLIB_DIR}/LibTomCrypt.c
  ${STORMLIB_DIR}/LibTomMath.c
  ${STORMLIB_DIR}/LibTomMathDesc.c
  ${STORMLIB_DIR}/SBaseCommon.cpp
  ${STORMLIB_DIR}/SBaseDumpData.cpp
  ${STORMLIB_DIR}/SBaseFileTable.cpp
  ${STORMLIB_DIR}/SBaseSubTypes.cpp
  ${STORMLIB_DIR}/SCompression.cpp
  ${STORMLIB_DIR}/SFileAddFile.cpp
  ${STORMLIB_DIR}/SFileAttributes.cpp
  ${STORMLIB_DIR}/SFileCompactArchive.cpp
  ${STORMLIB_DIR}/SFileCreateArchive.cpp
  ${STORMLIB_DIR}/SFileExtractFile.cpp
  ${STORMLIB_DIR}/SFileFindFile.cpp
  ${STORMLIB_DIR}/SFileGetFileInfo.cpp
  ${STORMLIB_DIR}/SFileListFile.cpp
  ${STORMLIB_DIR}/SFileOpenArchive.cpp
  ${STORMLIB_DIR}/SFileOpenFileEx.cpp
  ${STORMLIB_DIR}/SFilePatchArchives.cpp
  ${STORMLIB_DIR}/SFileReadFile.cpp
  ${STORMLIB_DIR}/SFileVerify.cpp
  ${STORMLIB_DIR}/SMemUtf8.cpp
)
file(GLOB STORMLIB_SUB CONFIGURE_DEPENDS
  ${STORMLIB_DIR}/zlib/*.c
  ${STORMLIB_DIR}/bzip2/*.c
  ${STORMLIB_DIR}/adpcm/*.c
  ${STORMLIB_DIR}/adpcm/*.cpp
  ${STORMLIB_DIR}/huffman/*.c
  ${STORMLIB_DIR}/huffman/*.cpp
  ${STORMLIB_DIR}/pklib/*.c
  ${STORMLIB_DIR}/jenkins/*.c
  ${STORMLIB_DIR}/sparse/*.cpp)
# zlib 目录里 compress.c 与 compress_zlib.c 重复定义 compress 系列，只留前者
list(FILTER STORMLIB_SUB EXCLUDE REGEX "compress_zlib\\.c$")
# lzma 单线程模块（SCompression 引用；多线程 LzFindMt/Threads 用 Windows API，wasm 不编）
set(STORMLIB_LZMA
  ${STORMLIB_DIR}/lzma/C/LzFind.c
  ${STORMLIB_DIR}/lzma/C/LzmaDec.c
  ${STORMLIB_DIR}/lzma/C/LzmaEnc.c)

# ---- 引擎目标 ----
add_executable(engine
  src/math.c
  src/w3x.c
  src/jass.c
  src/sim.c
  ${STORMLIB_CORE}
  ${STORMLIB_SUB}
  ${STORMLIB_LZMA}
)

target_include_directories(engine PRIVATE src extern/stormlib/src)

if(EMSCRIPTEN)
  add_compile_options(-O2 -fno-inline-functions)
  # 第三方 bzip2/zlib 是 MSVC 风格的（_fdopen/_stricmp），映射到 POSIX 名；
  # lzma 用单线程模式（_7ZIP_ST），避开 Windows 线程 API
  target_compile_definitions(engine PRIVATE _fdopen=fdopen _stricmp=strcasecmp _strnicmp=strncasecmp _7ZIP_ST)
  target_link_options(engine PRIVATE
    -Oz
    --no-entry
    "-sEXPORTED_FUNCTIONS=_w3x_check_header,_w3x_get_version,_w3x_open,_w3x_close,_w3x_has_file,_w3x_read,_vec3_lenf,_vec3_dotf,_vec3_crossf,_jass_parse,_jass_run,_sim_grid_init,_sim_find_path,_sim_find_path_r,_sim_clear_foot,_sim_connected_i,_sim_set_unit,_sim_set_path,_sim_run_move,_sim_spawn,_sim_clear_all,_sim_order_move,_sim_tick,_sim_get,_sim_get_path,_sim_move,_malloc,_free"
    -sMODULARIZE
    -sEXPORT_NAME=createEngine
    -sENVIRONMENT=node,web
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,ccall,stringToUTF8,UTF8ToString"
    -sFORCE_FILESYSTEM=1
  )
  set_target_properties(engine PROPERTIES OUTPUT_NAME "engine" SUFFIX ".mjs")
endif()