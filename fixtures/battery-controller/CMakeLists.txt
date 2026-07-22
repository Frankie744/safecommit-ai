cmake_minimum_required(VERSION 3.20)

project(safeflash_battery_controller LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(battery_controller STATIC
  src/battery_controller.c
)

target_include_directories(battery_controller
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(MSVC)
  target_compile_options(battery_controller PRIVATE /W4 /WX)
else()
  target_compile_options(battery_controller PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

enable_testing()

add_executable(battery_unit_tests
  tests/test_unit.c
)
target_link_libraries(battery_unit_tests PRIVATE battery_controller)
if(MSVC)
  target_compile_options(battery_unit_tests PRIVATE /W4 /WX)
else()
  target_compile_options(battery_unit_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
add_test(NAME battery_unit_tests COMMAND battery_unit_tests)
set_tests_properties(battery_unit_tests PROPERTIES
  LABELS "unit"
  TIMEOUT 5
)

add_executable(battery_safety_tests
  tests/test_safety.c
)
target_link_libraries(battery_safety_tests PRIVATE battery_controller)
if(MSVC)
  target_compile_options(battery_safety_tests PRIVATE /W4 /WX)
else()
  target_compile_options(battery_safety_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
add_test(NAME battery_safety_tests COMMAND battery_safety_tests)
set_tests_properties(battery_safety_tests PROPERTIES
  LABELS "safety"
  TIMEOUT 5
)
