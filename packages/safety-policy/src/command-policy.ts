export interface SandboxCommand {
  executable: string;
  args: readonly string[];
  workingDirectory: string;
}

export interface CommandPolicyResult {
  allowed: boolean;
  reason: string;
}

const DEFAULT_EXECUTABLE_ALLOWLIST = new Set([
  "git",
  "cmake",
  "ctest",
  "ninja",
  "sha256sum",
]);

const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "curl",
  "wget",
  "nc",
  "netcat",
]);

export function validateSandboxCommand(
  command: SandboxCommand,
  executableAllowlist: ReadonlySet<string> = DEFAULT_EXECUTABLE_ALLOWLIST,
): CommandPolicyResult {
  const executable = command.executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (!executable) return { allowed: false, reason: "Executable is empty." };
  if (SHELL_EXECUTABLES.has(executable)) {
    return { allowed: false, reason: "Shells and network download tools are forbidden." };
  }
  if (!executableAllowlist.has(executable)) {
    return { allowed: false, reason: `Executable ${executable} is not allowlisted.` };
  }
  if (
    executable === "git" &&
    (command.args.length === 0 ||
      !new Set([
        "clone",
        "checkout",
        "apply",
        "diff",
        "status",
        "rev-parse",
        "show",
        "hash-object",
      ]).has(command.args[0]!.toLowerCase()))
  ) {
    return { allowed: false, reason: "Git subcommand is not allowlisted." };
  }
  if (executable === "cmake" && command.args.includes("-P")) {
    return { allowed: false, reason: "CMake script mode is forbidden." };
  }
  if (
    command.args.some(
      (argument) =>
        argument.includes("\0") ||
        /(?:^|\s)(?:https?|ftp):\/\//iu.test(argument) ||
        /(?:\$\(|`|&&|\|\||;\s*(?:sh|bash|cmd|powershell)\b)/iu.test(argument),
    )
  ) {
    return { allowed: false, reason: "Command arguments contain shell or network syntax." };
  }
  const cwd = command.workingDirectory.replaceAll("\\", "/");
  if (cwd.split("/").includes("..")) {
    return { allowed: false, reason: "Working directory escapes the sandbox workspace." };
  }
  return { allowed: true, reason: "Command is an allowlisted argv invocation." };
}

export { DEFAULT_EXECUTABLE_ALLOWLIST };
