cmake_minimum_required(VERSION 3.15)
project(war3core C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# 唯一的 M1 内核：纯 C，无外部依赖
add_executable(war3core src/core.c)

# Emscripten 会把 executable 链接成 wasm；--no-entry 允许没有 main()
set_target_properties(war3core PROPERTIES SUFFIX ".js")

target_link_options(war3core PRIVATE
    "--no-entry"
    "-sEXPORTED_FUNCTIONS=_add,_multiply,_fib"
    "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap"
    "-sMODULARIZE=1"
    "-sEXPORT_NAME=createWar3Core"
    "-sENVIRONMENT=web,node"
    "-sALLOW_MEMORY_GROWTH=1"
)