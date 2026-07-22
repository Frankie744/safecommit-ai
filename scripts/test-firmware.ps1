[CmdletBinding()]
param(
    [string]$VisualStudioRoot = "D:\visual_studio",
    [string]$FixtureRoot = "",
    [string]$EvidenceRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($FixtureRoot)) {
    $FixtureRoot = Join-Path $repoRoot "fixtures\battery-controller"
}
if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
    $EvidenceRoot = Join-Path $repoRoot "artifacts\evidence\phase-1"
}

$FixtureRoot = [System.IO.Path]::GetFullPath($FixtureRoot)
$EvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
$VisualStudioRoot = [System.IO.Path]::GetFullPath($VisualStudioRoot)

function Find-CMakeExecutable {
    param([string]$VsRoot)

    $candidates = [System.Collections.Generic.List[string]]::new()
    $candidates.Add((Join-Path $VsRoot "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"))

    $onPath = Get-Command cmake.exe -ErrorAction SilentlyContinue
    if ($null -ne $onPath) {
        $candidates.Add($onPath.Source)
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }

    $searchRoot = Join-Path $VsRoot "Common7\IDE\CommonExtensions\Microsoft\CMake"
    if (Test-Path -LiteralPath $searchRoot -PathType Container) {
        $discovered = Get-ChildItem -LiteralPath $searchRoot -Filter cmake.exe -File -Recurse |
            Select-Object -First 1
        if ($null -ne $discovered) {
            return $discovered.FullName
        }
    }

    throw "CMake was not found on PATH or under $VsRoot."
}

function Find-MsvcCompiler {
    param([string]$VsRoot)

    $toolsRoot = Join-Path $VsRoot "VC\Tools\MSVC"
    if (-not (Test-Path -LiteralPath $toolsRoot -PathType Container)) {
        throw "MSVC tools directory was not found under $VsRoot."
    }

    $versions = Get-ChildItem -LiteralPath $toolsRoot -Directory |
        Sort-Object Name -Descending

    foreach ($version in $versions) {
        foreach ($relativePath in @(
            "bin\Hostx64\x64\cl.exe",
            "bin\Hostx86\x64\cl.exe",
            "bin\Hostx86\x86\cl.exe"
        )) {
            $candidate = Join-Path $version.FullName $relativePath
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return [System.IO.Path]::GetFullPath($candidate)
            }
        }
    }

    throw "cl.exe was not found under $toolsRoot."
}

function Protect-LogText {
    param([AllowEmptyString()][string]$Text)

    $safe = $Text
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $safe = $safe.Replace($env:USERPROFILE, "%USERPROFILE%")
    }

    $safe = [regex]::Replace(
        $safe,
        '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+',
        '$1[REDACTED]'
    )
    $safe = [regex]::Replace(
        $safe,
        '(?im)\b(api[_-]?key|token|secret|authorization)\b(\s*[:=]\s*)([^\s;]+)',
        '$1$2[REDACTED]'
    )
    $safe = [regex]::Replace(
        $safe,
        '(?i)(https?://)[^/@\s]+@',
        '$1[REDACTED]@'
    )

    return $safe
}

function Format-CommandArgument {
    param([string]$Argument)

    if ($Argument -match '[\s"]') {
        return '"' + $Argument.Replace('"', '\"') + '"'
    }
    return $Argument
}

function Invoke-LoggedNative {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$EvidenceDirectory
    )

    $displayArguments = $Arguments | ForEach-Object { Format-CommandArgument $_ }
    $displayCommand = (Format-CommandArgument $FilePath) + " " + ($displayArguments -join " ")
    Write-Host "[$Name] $displayCommand"

    $previousErrorActionPreference = $ErrorActionPreference
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        # Windows PowerShell promotes native stderr to ErrorRecord objects.
        # A failing CTest safety suite is expected here, so collect stderr
        # without allowing the process' non-zero exit to abort evidence capture.
        $ErrorActionPreference = "Continue"
        $outputLines = @(& $FilePath @Arguments 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    } finally {
        $stopwatch.Stop()
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $durationMs = [Math]::Round($stopwatch.Elapsed.TotalMilliseconds, 3)
    foreach ($line in $outputLines) {
        Write-Host $line
    }

    $rawText = @(
        "COMMAND: $displayCommand",
        "EXIT_CODE: $exitCode",
        "DURATION_MS: $durationMs",
        ""
    ) + $outputLines
    $safeText = Protect-LogText ($rawText -join [Environment]::NewLine)
    $logPath = Join-Path $EvidenceDirectory ($Name + ".log")
    [System.IO.File]::WriteAllText(
        $logPath,
        $safeText + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )

    return [pscustomobject]@{
        Name = $Name
        ExitCode = $exitCode
        DurationMs = $durationMs
        Output = ($outputLines -join [Environment]::NewLine)
        LogPath = $logPath
        Command = $displayCommand
    }
}

if (-not (Test-Path -LiteralPath $FixtureRoot -PathType Container)) {
    throw "Fixture directory does not exist: $FixtureRoot"
}
if (-not (Test-Path -LiteralPath $VisualStudioRoot -PathType Container)) {
    throw "Visual Studio root does not exist: $VisualStudioRoot"
}

$cmakePath = Find-CMakeExecutable $VisualStudioRoot
$ctestPath = Join-Path (Split-Path -Parent $cmakePath) "ctest.exe"
if (-not (Test-Path -LiteralPath $ctestPath -PathType Leaf)) {
    throw "ctest.exe was not found next to CMake: $ctestPath"
}
$clPath = Find-MsvcCompiler $VisualStudioRoot
$msbuildPath = Join-Path $VisualStudioRoot "MSBuild\Current\Bin\MSBuild.exe"
if (-not (Test-Path -LiteralPath $msbuildPath -PathType Leaf)) {
    throw "MSBuild.exe was not found under $VisualStudioRoot."
}

$cmakeHelp = @(& $cmakePath --help 2>&1 | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0) {
    throw "Unable to query CMake generators."
}
$generatorMatch = [regex]::Match(
    $cmakeHelp,
    '(?m)^\*?\s*(Visual Studio[^=\r\n]+?)\s*='
)
if (-not $generatorMatch.Success) {
    throw "No Visual Studio generator was reported by $cmakePath."
}
$generator = $generatorMatch.Groups[1].Value.Trim()

$runId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$evidenceDirectory = Join-Path $EvidenceRoot $runId
$buildDirectory = Join-Path $repoRoot ("artifacts\build\phase-1\" + $runId)
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null

$cmakeVersion = (& $cmakePath --version 2>&1 | Select-Object -First 1).ToString()
$clVersion = (Get-Item -LiteralPath $clPath).VersionInfo.FileVersion
$toolchain = [ordered]@{
    capturedAt = [DateTime]::UtcNow.ToString("o")
    visualStudioRoot = Protect-LogText $VisualStudioRoot
    cmakePath = Protect-LogText $cmakePath
    cmakeVersion = $cmakeVersion
    ctestPath = Protect-LogText $ctestPath
    compilerPath = Protect-LogText $clPath
    compilerFileVersion = $clVersion
    msbuildPath = Protect-LogText $msbuildPath
    generator = $generator
    architecture = "x64"
}
[System.IO.File]::WriteAllText(
    (Join-Path $evidenceDirectory "toolchain.json"),
    ($toolchain | ConvertTo-Json -Depth 4) + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)

$configureInvocation = @{
    Name = "configure"
    FilePath = $cmakePath
    Arguments = @(
        "-S", $FixtureRoot,
        "-B", $buildDirectory,
        "-G", $generator,
        "-A", "x64",
        "-DCMAKE_GENERATOR_INSTANCE=$VisualStudioRoot"
    )
    EvidenceDirectory = $evidenceDirectory
}
$configure = Invoke-LoggedNative @configureInvocation
if ($configure.ExitCode -ne 0) {
    throw "CMake configure failed with exit code $($configure.ExitCode)."
}

$buildInvocation = @{
    Name = "build"
    FilePath = $cmakePath
    Arguments = @("--build", $buildDirectory, "--config", "Debug", "--parallel")
    EvidenceDirectory = $evidenceDirectory
}
$build = Invoke-LoggedNative @buildInvocation
if ($build.ExitCode -ne 0) {
    throw "Firmware build failed with exit code $($build.ExitCode)."
}

$unitInvocation = @{
    Name = "unit-tests"
    FilePath = $ctestPath
    Arguments = @(
        "--test-dir", $buildDirectory,
        "-C", "Debug",
        "-V",
        "-L", "unit",
        "--output-on-failure",
        "--no-tests=error"
    )
    EvidenceDirectory = $evidenceDirectory
}
$unit = Invoke-LoggedNative @unitInvocation
if ($unit.ExitCode -ne 0) {
    throw "Unit tests failed with exit code $($unit.ExitCode)."
}

$safetyInvocation = @{
    Name = "safety-tests"
    FilePath = $ctestPath
    Arguments = @(
        "--test-dir", $buildDirectory,
        "-C", "Debug",
        "-V",
        "-L", "safety",
        "--output-on-failure",
        "--no-tests=error"
    )
    EvidenceDirectory = $evidenceDirectory
}
$safety = Invoke-LoggedNative @safetyInvocation
if ($safety.ExitCode -eq 0) {
    throw "Safety tests unexpectedly passed; the unsafe baseline is no longer reproducible."
}

$expectedFailingMarkers = @(
    "[FAIL] sensor_disconnect_enters_safe_state",
    "[FAIL] stale_sample_limit_enters_safe_state",
    "[FAIL] normal_sample_cannot_clear_latched_fault"
)
$expectedPassingMarkers = @(
    "[PASS] below_minimum_temperature_enters_safe_state",
    "[PASS] above_maximum_temperature_enters_safe_state",
    "[PASS] explicit_reset_allows_controlled_recovery",
    "[SUMMARY] 3 passed, 3 failed"
)

foreach ($marker in $expectedFailingMarkers + $expectedPassingMarkers) {
    if (-not $safety.Output.Contains($marker)) {
        throw "Safety test output did not contain required marker: $marker"
    }
}

$summary = [ordered]@{
    schemaVersion = 1
    runId = $runId
    capturedAt = [DateTime]::UtcNow.ToString("o")
    result = "EXPECTED_UNSAFE_BASELINE_CONFIRMED"
    fixture = Protect-LogText $FixtureRoot
    buildDirectory = Protect-LogText $buildDirectory
    toolchain = $toolchain
    configure = [ordered]@{
        exitCode = $configure.ExitCode
        durationMs = $configure.DurationMs
        passed = $true
        log = "configure.log"
    }
    build = [ordered]@{
        exitCode = $build.ExitCode
        durationMs = $build.DurationMs
        passed = $true
        log = "build.log"
    }
    unitTests = [ordered]@{
        exitCode = $unit.ExitCode
        durationMs = $unit.DurationMs
        passed = $true
        expected = "all unit tests pass"
        log = "unit-tests.log"
    }
    safetyTests = [ordered]@{
        exitCode = $safety.ExitCode
        durationMs = $safety.DurationMs
        passed = $false
        expectedFailureObserved = $true
        expectedFailingTests = $expectedFailingMarkers | ForEach-Object { $_.Substring(7) }
        expectedPassingTests = $expectedPassingMarkers[0..2] | ForEach-Object { $_.Substring(7) }
        log = "safety-tests.log"
    }
}
$summaryPath = Join-Path $evidenceDirectory "summary.json"
[System.IO.File]::WriteAllText(
    $summaryPath,
    ($summary | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)

New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null
[System.IO.File]::WriteAllText(
    (Join-Path $EvidenceRoot "latest-run.txt"),
    $runId + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "PHASE1_RESULT=PASS"
Write-Host "BUILD_EXIT=$($build.ExitCode)"
Write-Host "UNIT_EXIT=$($unit.ExitCode)"
Write-Host "SAFETY_EXIT=$($safety.ExitCode) (EXPECTED_NONZERO)"
Write-Host "EVIDENCE=$evidenceDirectory"
