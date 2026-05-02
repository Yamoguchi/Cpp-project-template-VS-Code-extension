import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

type CompilerChoice = {
    readonly label: string;
    readonly cCompiler: string;
    readonly cxxCompiler: string;
    readonly debuggerType: 'cppdbg' | 'cppvsdbg' | 'lldb';
    readonly warningFlags: readonly string[];
    readonly platformHint?: NodeJS.Platform;
};

type ProjectConfig = {
    readonly targetDir: string;
    readonly projectName: string;
    readonly compiler: CompilerChoice;
    readonly useVcpkg: boolean;
    readonly vcpkgToolchainFile?: string;
};

type ProjectFile = {
    readonly relativePath: string;
    readonly content: string;
};

type BuildPreset = {
    readonly name: string;
    readonly displayName: string;
    readonly buildType: 'Debug' | 'Release';
};

const buildPresets: readonly BuildPreset[] = [
    { name: 'debug', displayName: 'Debug', buildType: 'Debug' },
    { name: 'release', displayName: 'Release', buildType: 'Release' }
];

const compilers: readonly CompilerChoice[] = [
    {
        label: 'Clang',
        cCompiler: 'clang',
        cxxCompiler: 'clang++',
        debuggerType: 'lldb',
        warningFlags: ['-Wall', '-Wextra', '-Wpedantic', '-Wconversion', '-Wshadow']
    },
    {
        label: 'GCC',
        cCompiler: 'gcc',
        cxxCompiler: 'g++',
        debuggerType: 'cppdbg',
        warningFlags: ['-Wall', '-Wextra', '-Wpedantic', '-Wconversion', '-Wshadow']
    },
    {
        label: 'MSVC',
        cCompiler: 'cl',
        cxxCompiler: 'cl',
        debuggerType: 'cppvsdbg',
        warningFlags: ['/W4', '/permissive-'],
        platformHint: 'win32'
    }
];

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand(
        'cppTemplateGenerator.createProject',
        createProject
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {
    // Nothing to clean up.
}

async function createProject() {
    try {
        const config = await collectProjectConfig();
        if (!config) {
            return;
        }

        await warnAboutMissingTools(config.compiler);
        await writeProject(config);
        await vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(config.targetDir),
            false
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(message);
    }
}

async function collectProjectConfig(): Promise<ProjectConfig | undefined> {
    const parentDir = await chooseParentDirectory();
    if (!parentDir) {
        return undefined;
    }

    const projectName = await chooseProjectName();
    if (!projectName) {
        return undefined;
    }

    const targetDir = path.join(parentDir, projectName);
    if (await pathExists(targetDir)) {
        throw new Error(`Directory already exists: ${targetDir}`);
    }

    const compiler = await chooseCompiler();
    if (!compiler) {
        return undefined;
    }

    const useVcpkg = await chooseVcpkg();
    if (useVcpkg === undefined) {
        return undefined;
    }

    const vcpkgToolchainFile = useVcpkg ? await resolveVcpkgToolchainFile() : undefined;
    if (useVcpkg && !vcpkgToolchainFile) {
        return undefined;
    }

    return {
        targetDir,
        projectName,
        compiler,
        useVcpkg,
        vcpkgToolchainFile
    };
}

async function chooseParentDirectory(): Promise<string | undefined> {
    const selected = await vscode.window.showOpenDialog({
        title: 'Choose where to create the C++ project',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Choose Folder'
    });

    return selected?.[0]?.fsPath;
}

async function chooseProjectName(): Promise<string | undefined> {
    const projectName = await vscode.window.showInputBox({
        title: 'C++ project name',
        prompt: 'Enter the new project directory and CMake target name.',
        placeHolder: 'MyCppProject',
        validateInput: (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
                return 'Project name is required.';
            }

            if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) {
                return 'Use letters, numbers, underscore, or dash. The first character must be a letter or underscore.';
            }

            return undefined;
        }
    });

    return projectName?.trim();
}

async function chooseCompiler(): Promise<CompilerChoice | undefined> {
    const selected = await vscode.window.showQuickPick(
        orderedCompilers().map((compiler) => ({
            label: compiler.label,
            description: `${compiler.cCompiler} / ${compiler.cxxCompiler}`,
            detail: compiler.platformHint ? 'Best used from a Visual Studio Developer environment' : undefined,
            compiler
        })),
        {
            title: 'Choose C++ compiler',
            placeHolder: 'Compiler used in CMake configuration'
        }
    );

    return selected?.compiler;
}

function orderedCompilers(): readonly CompilerChoice[] {
    return [...compilers].sort((left, right) => {
        const leftMatchesPlatform = left.platformHint === process.platform;
        const rightMatchesPlatform = right.platformHint === process.platform;

        if (leftMatchesPlatform === rightMatchesPlatform) {
            return 0;
        }

        return leftMatchesPlatform ? -1 : 1;
    });
}

async function chooseVcpkg(): Promise<boolean | undefined> {
    const selected = await vscode.window.showQuickPick(
        [
            { label: 'No vcpkg', value: false },
            { label: 'Use vcpkg', value: true }
        ],
        {
            title: 'Use vcpkg?',
            placeHolder: 'Choose whether to create vcpkg files and CMake presets'
        }
    );

    return selected?.value;
}

async function resolveVcpkgToolchainFile(): Promise<string | undefined> {
    const fromEnvironment = process.env.VCPKG_ROOT
        ? path.join(process.env.VCPKG_ROOT, 'scripts', 'buildsystems', 'vcpkg.cmake')
        : undefined;

    if (fromEnvironment && (await pathExists(fromEnvironment))) {
        return fromEnvironment;
    }

    const selected = await vscode.window.showOpenDialog({
        title: 'Select vcpkg.cmake toolchain file',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Use Toolchain File',
        filters: {
            'CMake files': ['cmake'],
            'All files': ['*']
        }
    });

    const toolchainFile = selected?.[0]?.fsPath;
    if (!toolchainFile) {
        return undefined;
    }

    if (path.basename(toolchainFile) !== 'vcpkg.cmake') {
        throw new Error('Selected file must be named vcpkg.cmake.');
    }

    return toolchainFile;
}

async function warnAboutMissingTools(compiler: CompilerChoice) {
    const tools = Array.from(new Set(['cmake', 'ninja', compiler.cCompiler, compiler.cxxCompiler]));
    const toolChecks = await Promise.all(tools.map(async (tool) => ({ tool, exists: await commandExists(tool) })));
    const missing = toolChecks.filter((check) => !check.exists).map((check) => check.tool);

    if (missing.length > 0) {
        const choice = await vscode.window.showWarningMessage(
            `These tools were not found in PATH: ${missing.join(', ')}. Create the project anyway?`,
            { modal: true },
            'Create Anyway'
        );

        if (choice !== 'Create Anyway') {
            throw new Error('Project creation cancelled.');
        }
    }
}

async function commandExists(command: string): Promise<boolean> {
    const checker = process.platform === 'win32' ? 'where' : 'which';

    try {
        await execFileAsync(checker, [command]);
        return true;
    } catch {
        return false;
    }
}

async function writeProject(config: ProjectConfig) {
    if (config.useVcpkg && !config.vcpkgToolchainFile) {
        throw new Error('vcpkg toolchain file was not resolved.');
    }

    const files = projectFiles(config);
    const directories = new Set(
        files.map((file) => path.dirname(projectFilePath(config.targetDir, file)))
    );

    await Promise.all([...directories].map((directory) => fs.mkdir(directory, { recursive: true })));
    await Promise.all(files.map((file) => writeFile(config.targetDir, file)));
}

function projectFiles(config: ProjectConfig): readonly ProjectFile[] {
    const files: ProjectFile[] = [
        { relativePath: 'CMakeLists.txt', content: cmakeLists(config) },
        { relativePath: 'CMakePresets.json', content: cmakePresets(config) },
        { relativePath: 'src/main.cpp', content: mainCpp() },
        { relativePath: '.vscode/settings.json', content: settingsJson() },
        { relativePath: '.vscode/tasks.json', content: tasksJson() },
        { relativePath: '.vscode/launch.json', content: launchJson(config.compiler) },
        { relativePath: '.clang-format', content: clangFormat() },
        { relativePath: '.clang-tidy', content: clangTidy() },
        { relativePath: '.gitignore', content: gitignore() }
    ];

    if (config.useVcpkg) {
        files.push({ relativePath: 'vcpkg.json', content: vcpkgJson(config.projectName) });
    }

    return files;
}

async function writeFile(targetDir: string, file: ProjectFile) {
    await fs.writeFile(projectFilePath(targetDir, file), file.content, 'utf8');
}

function projectFilePath(targetDir: string, file: ProjectFile): string {
    return path.join(targetDir, ...file.relativePath.split('/'));
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function json(value: unknown): string {
    return `${JSON.stringify(value, null, 4)}\n`;
}

function cmakeLists(config: ProjectConfig): string {
    const flags = config.compiler.warningFlags.map((flag) => `    ${flag}`).join('\n');

    return `cmake_minimum_required(VERSION 3.20)

project(${config.projectName} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_executable(\${PROJECT_NAME}
    src/main.cpp
)

target_compile_options(\${PROJECT_NAME} PRIVATE
${flags}
)
`;
}

function mainCpp(): string {
    return `#include <iostream>

int main() {
    std::cout << "Hello, World!" << '\\n';
    return 0;
}
`;
}

function cmakePresets(config: ProjectConfig): string {
    const cacheVariables = cmakeCacheVariables(config);
    return json({
        version: 6,
        configurePresets: buildPresets.map((preset) => ({
            name: preset.name,
            displayName: preset.displayName,
            description: `${preset.displayName} build using Ninja and ${config.compiler.label}`,
            generator: 'Ninja',
            binaryDir: `\${sourceDir}/build/${preset.name}`,
            cacheVariables: {
                ...cacheVariables,
                CMAKE_BUILD_TYPE: preset.buildType
            }
        })),
        buildPresets: buildPresets.map((preset) => ({
            name: preset.name,
            configurePreset: preset.name
        }))
    });
}

function cmakeCacheVariables(config: ProjectConfig): Record<string, string> {
    const cacheVariables: Record<string, string> = {
        CMAKE_EXPORT_COMPILE_COMMANDS: 'ON'
    };

    if (config.compiler.cCompiler === config.compiler.cxxCompiler) {
        cacheVariables.CMAKE_CXX_COMPILER = config.compiler.cxxCompiler;
    } else {
        cacheVariables.CMAKE_C_COMPILER = config.compiler.cCompiler;
        cacheVariables.CMAKE_CXX_COMPILER = config.compiler.cxxCompiler;
    }

    if (config.vcpkgToolchainFile) {
        cacheVariables.CMAKE_TOOLCHAIN_FILE = config.vcpkgToolchainFile;
    }

    return cacheVariables;
}

function vcpkgJson(projectName: string): string {
    return json({
        name: vcpkgManifestName(projectName),
        'version-string': '0.1.0',
        dependencies: []
    });
}

function vcpkgManifestName(projectName: string): string {
    const normalized = projectName
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');

    return normalized || 'cpp-project';
}

function settingsJson(): string {
    return json({
        'cmake.useCMakePresets': 'always',
        'cmake.configureOnOpen': true,
        'cmake.copyCompileCommands': '${workspaceFolder}/compile_commands.json',
        'clangd.arguments': [
            '--background-index',
            '--clang-tidy',
            '--completion-style=detailed',
            '--header-insertion=iwyu',
            '--pch-storage=memory'
        ],
        'C_Cpp.intelliSenseEngine': 'disabled',
        'editor.formatOnSave': true,
        '[cpp]': {
            'editor.defaultFormatter': 'llvm-vs-code-extensions.vscode-clangd'
        },
        '[c]': {
            'editor.defaultFormatter': 'llvm-vs-code-extensions.vscode-clangd'
        }
    });
}

function tasksJson(): string {
    return json({
        version: '2.0.0',
        tasks: [
            {
                type: 'cmake',
                label: 'CMake: build',
                command: 'build',
                group: {
                    kind: 'build',
                    isDefault: true
                },
                problemMatcher: [],
                detail: 'Build using the active CMake Tools configuration'
            }
        ]
    });
}

function launchJson(compiler: CompilerChoice): string {
    const baseConfig = {
        request: 'launch',
        name: 'Debug CMake Target',
        program: '${command:cmake.launchTargetPath}',
        args: [],
        cwd: '${workspaceFolder}',
        preLaunchTask: 'CMake: build'
    };

    if (compiler.debuggerType === 'cppvsdbg') {
        return json({
            version: '0.2.0',
            configurations: [
                {
                    ...baseConfig,
                    type: 'cppvsdbg',
                    console: 'integratedTerminal'
                }
            ]
        });
    }

    if (compiler.debuggerType === 'cppdbg') {
        return json({
            version: '0.2.0',
            configurations: [
                {
                    ...baseConfig,
                    type: 'cppdbg',
                    console: 'integratedTerminal',
                    MIMode: 'gdb'
                }
            ]
        });
    }

    return json({
        version: '0.2.0',
        configurations: [
            {
                ...baseConfig,
                type: 'lldb',
                terminal: 'integrated'
            }
        ]
    });
}

function clangFormat(): string {
    return `BasedOnStyle: LLVM
IndentWidth: 4
TabWidth: 4
UseTab: Never
ColumnLimit: 100
BreakBeforeBraces: Attach
AllowShortFunctionsOnASingleLine: Empty
AllowShortIfStatementsOnASingleLine: Never
AllowShortLoopsOnASingleLine: false
PointerAlignment: Left
ReferenceAlignment: Left
SortIncludes: true
`;
}

function clangTidy(): string {
    return `Checks: >
  bugprone-*,
  clang-analyzer-*,
  cppcoreguidelines-*,
  modernize-*,
  performance-*,
  readability-*,
  -modernize-use-trailing-return-type,
  -cppcoreguidelines-avoid-magic-numbers,
  -readability-magic-numbers,
  -cppcoreguidelines-pro-bounds-pointer-arithmetic,
  -cppcoreguidelines-pro-type-reinterpret-cast

WarningsAsErrors: ''

HeaderFilterRegex: '.*'

FormatStyle: file
`;
}

function gitignore(): string {
    return `build/
.cache/
.vscode/.cmake/
`;
}
