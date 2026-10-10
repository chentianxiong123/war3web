# ============================================================================
# war3engine — war3web 的 C++/C 引擎（Emscripten 主线）。
# 配置：emcmake cmake -G Ninja -B build-web
# 构建：ninja -C build-web
# 参考 WhiteoutFlakes 的 wasm 配置精神：无异常、编译 -O2、链接 -Oz、
# 禁止内联大函数（规避 Chrome V8 wasm 编译冻结）。
# ============================================================================
cmake_minimum_required(VERSION 3.20)
project(war3engine LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(engine
  src/math.c
  src/w3x.c
)

target_include_directories(engine PRIVATE src)

if(EMSCRIPTEN)
  add_compile_options(-O2 -fno-inline-functions)
  target_link_options(engine PRIVATE
    -Oz
    --no-entry
    "-sEXPORTED_FUNCTIONS=_w3x_check_header,_w3x_get_version,_vec3_lenf,_vec3_dotf,_vec3_crossf,_malloc,_free"
    -sMODULARIZE
    -sEXPORT_NAME=createEngine
    -sENVIRONMENT=node,web
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32
  )
  set_target_properties(engine PROPERTIES OUTPUT_NAME "engine" SUFFIX ".mjs")
endif()
