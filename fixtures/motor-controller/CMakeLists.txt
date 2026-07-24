cmake_minimum_required(VERSION 3.20)

project(safeflash_motor_controller LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(motor_controller STATIC
  src/motor_controller.c
)

target_include_directories(motor_controller
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(MSVC)
  target_compile_options(motor_controller PRIVATE /W4 /WX)
else()
  target_compile_options(motor_controller PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

enable_testing()

add_executable(motor_unit_tests
  tests/test_unit.c
)
target_link_libraries(motor_unit_tests PRIVATE motor_controller)
if(MSVC)
  target_compile_options(motor_unit_tests PRIVATE /W4 /WX)
else()
  target_compile_options(motor_unit_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
add_test(NAME motor_unit_tests COMMAND motor_unit_tests)
set_tests_properties(motor_unit_tests PROPERTIES LABELS "unit" TIMEOUT 5)

add_executable(motor_safety_tests
  tests/test_safety.c
)
target_link_libraries(motor_safety_tests PRIVATE motor_controller)
if(MSVC)
  target_compile_options(motor_safety_tests PRIVATE /W4 /WX)
else()
  target_compile_options(motor_safety_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
add_test(NAME motor_safety_tests COMMAND motor_safety_tests)
set_tests_properties(motor_safety_tests PROPERTIES LABELS "safety" TIMEOUT 5)
