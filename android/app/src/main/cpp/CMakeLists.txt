cmake_minimum_required(VERSION 3.22.1)
project(cicatavern)

add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE ${NODE_MOBILE}/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${NODE_MOBILE}/bin/${ANDROID_ABI}/libnode.so)

target_link_libraries(native-lib libnode)
