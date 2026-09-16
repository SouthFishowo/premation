# cmake-js build of the example addon.
#
# The alternative to binding.gyp, and the one to prefer for an addon that has
# real dependencies: CMake can find them, gyp cannot without a generator of its
# own. Both produce the same `.node`, and the editor cannot tell which was used.
#
#   npm install
#   npx cmake-js compile --runtime electron --runtime-version <electron version>
#
cmake_minimum_required(VERSION 3.15)
project(motion_example)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_definitions(-DNAPI_DISABLE_CPP_EXCEPTIONS)

file(GLOB SOURCE_FILES "src/*.cc")
add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

# `node-addon-api` ships headers only; `CMAKE_JS_INC` is where cmake-js puts
# the Node/Electron headers it downloaded for the runtime named above.
execute_process(
  COMMAND node -p "require('node-addon-api').include_dir"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
  "${CMAKE_CURRENT_SOURCE_DIR}/../include"
)

target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

# Windows: Node/Electron resolve the addon's symbols at load time from the host
# executable, so the delay-load hook is not optional.
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(
    COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS}
  )
endif()
