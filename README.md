# C++ Template Generator

VS Code extension that creates a CMake C++ project matching the provided Bash template.

## Usage

1. Open VS Code.
2. Run `C++ Template: Create Project` from `Ctrl+Shift+P`.
3. Choose the parent folder.
4. Enter the project name.
5. Choose the compiler.
6. Choose whether to use vcpkg.

The extension creates:

- `CMakeLists.txt`
- `src/main.cpp`
- `.vscode/settings.json`
- `.vscode/tasks.json`
- `.vscode/launch.json`
- `.clang-format`
- `.clang-tidy`
- `.gitignore`
- `CMakePresets.json`
- `vcpkg.json` when vcpkg is enabled

Generated CMake presets include two build options: `Debug` and `Release`.

When vcpkg is enabled, the extension uses `VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake` if `VCPKG_ROOT` is set. If it is not set, it asks you to select the `vcpkg.cmake` toolchain file.

## Platform Notes

The extension can run on Linux, macOS, and Windows.

- Linux/macOS: use Clang or GCC with Ninja and CMake available in `PATH`.
- Windows: use Clang, GCC, or MSVC. MSVC works best when VS Code is started from a Visual Studio Developer environment so `cl`, `cmake`, and `ninja` are available in `PATH`.
- The generated VS Code settings do not hardcode a platform-specific `clangd` path. If clangd is not in `PATH`, configure it in your user settings.

## Development

Install dependencies, compile, then press `F5` in VS Code to launch an Extension Development Host.

```bash
npm install
npm run compile
```
