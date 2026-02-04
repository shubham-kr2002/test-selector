#Requires -Version 5.1
<#
.SYNOPSIS
    Smart Test Selector - Playwright Runner
    
.DESCRIPTION
    Production-grade bridge between Smart Test Selector CLI and Playwright.
    Analyzes git changes and runs only the impacted tests.
    
.PARAMETER RepoPath
    Path to the target repository (default: current directory)
    
.PARAMETER SmartToolPath
    Path to the Smart Test Selector index.ts file
    
.PARAMETER CommitSha
    Git commit SHA to analyze (default: HEAD)
    
.PARAMETER RunAll
    Skip smart selection and run all tests
    
.PARAMETER Verbose
    Show detailed output including raw JSON
    
.EXAMPLE
    ./run-smart-tests.ps1 -CommitSha HEAD
    
.EXAMPLE
    ./run-smart-tests.ps1 -RepoPath "../flash-tests" -CommitSha "abc123"
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$RepoPath = ".",
    
    [Parameter()]
    [string]$SmartToolPath = ".\src\index.ts",
    
    [Parameter()]
    [string]$CommitSha = "HEAD",
    
    [Parameter()]
    [switch]$RunAll
)

# Strict mode for production safety
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

#region Helper Functions

function Write-Banner {
    param([string]$Title)
    $line = "=" * 55
    Write-Host $line -ForegroundColor Cyan
    Write-Host "[*] $Title" -ForegroundColor Cyan
    Write-Host $line -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "[*] $Message" -ForegroundColor Gray
}

function Write-Step {
    param([string]$Message)
    Write-Host "[*] $Message" -ForegroundColor Yellow
}

function Write-Success {
    param([string]$Message)
    Write-Host "[+] $Message" -ForegroundColor Green
}

function Write-Failure {
    param([string]$Message)
    Write-Host "[-] $Message" -ForegroundColor Red
}

function Write-Warning {
    param([string]$Message)
    Write-Host "[!] $Message" -ForegroundColor Yellow
}

function Write-Detail {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Test-NodeModules {
    param([string]$Path)
    $nodeModulesPath = Join-Path $Path "node_modules"
    return Test-Path $nodeModulesPath -PathType Container
}

function Invoke-SmartSelector {
    <#
    .SYNOPSIS
        Securely invokes the Smart Test Selector and captures JSON output.
        Separates stdout (JSON) from stderr (warnings/errors).
    #>
    param(
        [string]$ToolPath,
        [string]$RepoPath,
        [string]$CommitSha
    )
    
    $result = @{
        Success = $false
        Data = $null
        Error = $null
    }
    
    try {
        # Create temp files for stdout and stderr separation
        $stdoutFile = [System.IO.Path]::GetTempFileName()
        $stderrFile = [System.IO.Path]::GetTempFileName()
        
        try {
            # Get the directory of the tool for node_modules resolution
            $toolDir = Split-Path $ToolPath -Parent | Split-Path -Parent
            
            # Build the command - use cmd.exe to run npx properly on Windows
            # npx is a batch file on Windows, so we need to invoke it through cmd
            $escapedToolPath = $ToolPath -replace '"', '\"'
            $escapedRepoPath = $RepoPath -replace '"', '\"'
            $command = "npx ts-node `"$escapedToolPath`" --repo `"$escapedRepoPath`" --commit $CommitSha --json"
            
            $processInfo = @{
                FilePath = "cmd.exe"
                ArgumentList = @("/c", $command)
                WorkingDirectory = $toolDir
                Wait = $true
                NoNewWindow = $true
                RedirectStandardOutput = $stdoutFile
                RedirectStandardError = $stderrFile
                PassThru = $true
            }
            
            $process = Start-Process @processInfo
            
            # Read outputs
            $stdout = Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue
            $stderr = Get-Content $stderrFile -Raw -ErrorAction SilentlyContinue
            
            # Display stderr (warnings) to console without breaking JSON
            if ($stderr -and $stderr.Trim()) {
                Write-Host ""
                Write-Warning "Tool warnings/info:"
                $stderr -split "`n" | ForEach-Object {
                    if ($_.Trim()) {
                        Write-Detail $_.Trim()
                    }
                }
                Write-Host ""
            }
            
            # Validate and parse JSON
            if ([string]::IsNullOrWhiteSpace($stdout)) {
                throw "Smart Test Selector returned empty output"
            }
            
            # Parse JSON
            $jsonData = $stdout | ConvertFrom-Json
            
            $result.Success = $true
            $result.Data = $jsonData
            
        } finally {
            # Clean up temp files
            Remove-Item $stdoutFile -Force -ErrorAction SilentlyContinue
            Remove-Item $stderrFile -Force -ErrorAction SilentlyContinue
        }
        
    } catch {
        $result.Error = $_.Exception.Message
    }
    
    return $result
}

function Invoke-PlaywrightWithGrep {
    <#
    .SYNOPSIS
        Safely invokes Playwright with a grep pattern.
        Properly escapes the pattern to prevent PowerShell interpretation.
    #>
    param(
        [string]$GrepPattern,
        [string]$RepoPath
    )
    
    # Display the command for debugging
    Write-Info "Executing Playwright..."
    Write-Detail "Command: npx playwright test --grep `"$GrepPattern`""
    Write-Host ""
    
    # Use the call operator with proper quoting
    # The pattern is passed as a single string argument with proper escaping
    Push-Location $RepoPath
    try {
        # Use --% to stop PowerShell parsing (literal mode)
        # Or pass as array elements which PowerShell handles correctly
        & npx playwright test --grep "$GrepPattern"
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Invoke-PlaywrightWithFiles {
    <#
    .SYNOPSIS
        Safely invokes Playwright with specific test files.
    #>
    param(
        [string[]]$Files,
        [string]$RepoPath
    )
    
    # Display the command for debugging
    $filesDisplay = $Files -join " "
    Write-Info "Executing Playwright..."
    Write-Detail "Command: npx playwright test $filesDisplay"
    Write-Host ""
    
    Push-Location $RepoPath
    try {
        # Splat the files array to pass each as a separate argument
        & npx playwright test @Files
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Invoke-PlaywrightAll {
    <#
    .SYNOPSIS
        Runs all Playwright tests (fallback/safe mode).
    #>
    param([string]$RepoPath)
    
    Write-Warning "Running ALL tests (Safe Mode)"
    Write-Detail "Command: npx playwright test"
    Write-Host ""
    
    Push-Location $RepoPath
    try {
        & npx playwright test
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

#endregion

#region Main Script

Write-Banner "Smart Test Selector - Playwright Runner"

# Resolve paths
$RepoPath = Resolve-Path $RepoPath -ErrorAction SilentlyContinue
if (-not $RepoPath) {
    Write-Failure "Repository path does not exist: $RepoPath"
    exit 1
}

Write-Info "Repository: $RepoPath"
Write-Info "Commit: $CommitSha"

# Validate Smart Tool path
$resolvedToolPath = $null
if ([System.IO.Path]::IsPathRooted($SmartToolPath)) {
    $resolvedToolPath = $SmartToolPath
} else {
    # Try to resolve relative path from current location
    $resolvedToolPath = Join-Path (Get-Location) $SmartToolPath
}

if (-not (Test-Path $resolvedToolPath -PathType Leaf)) {
    # Try alternate common locations
    $alternates = @(
        "..\smart-test-selector\src\index.ts",
        "..\test-selector\src\index.ts",
        "..\..\smart-test-selector\src\index.ts"
    )
    
    foreach ($alt in $alternates) {
        $altPath = Join-Path (Get-Location) $alt
        if (Test-Path $altPath -PathType Leaf) {
            $resolvedToolPath = $altPath
            break
        }
    }
}

if (-not (Test-Path $resolvedToolPath -PathType Leaf)) {
    Write-Failure "Smart Test Selector not found at: $SmartToolPath"
    Write-Detail "Searched paths:"
    Write-Detail "  - $SmartToolPath"
    Write-Detail "  - ..\smart-test-selector\src\index.ts"
    Write-Detail "  - ..\test-selector\src\index.ts"
    Write-Host ""
    Write-Info "Please specify the correct path using -SmartToolPath parameter"
    exit 1
}

Write-Info "Tool path: $resolvedToolPath"

# Validate node_modules in target repo
if (-not (Test-NodeModules $RepoPath)) {
    Write-Failure "node_modules not found in target repository: $RepoPath"
    Write-Host ""
    Write-Info "Please run the following command first:"
    Write-Detail "cd $RepoPath && npm install"
    exit 1
}

# Check if we should skip smart selection
if ($RunAll) {
    Write-Warning "RunAll flag specified - skipping smart selection"
    $exitCode = Invoke-PlaywrightAll -RepoPath $RepoPath
    exit $exitCode
}

# Run Smart Test Selector
Write-Host ""
Write-Step "Running Smart Test Selector..."

$selectorResult = Invoke-SmartSelector -ToolPath $resolvedToolPath -RepoPath $RepoPath -CommitSha $CommitSha

if (-not $selectorResult.Success) {
    Write-Failure "Smart Test Selector failed: $($selectorResult.Error)"
    Write-Warning "Falling back to Safe Mode (Run All Tests)"
    Write-Host ""
    
    $exitCode = Invoke-PlaywrightAll -RepoPath $RepoPath
    exit $exitCode
}

$data = $selectorResult.Data

# Verbose output
if ($VerbosePreference -eq "Continue") {
    Write-Info "Raw JSON data:"
    Write-Detail ($data | ConvertTo-Json -Compress)
}

# Check for empty results
if ($null -eq $data.files -or $data.files.Count -eq 0) {
    Write-Success "No impacted tests found. Nothing to run."
    exit 0
}

# Display analysis results
Write-Host ""
Write-Step "Analysis Results:"
Write-Host "    Files impacted: $($data.files.Count)" -ForegroundColor Green
Write-Host "    Tests impacted: $($data.tests.Count)" -ForegroundColor Green

# Display dynamic test warning if applicable
if ($data.hasDynamicTests -eq $true) {
    Write-Host ""
    Write-Warning "Some tests have dynamic names (template literals with variables)."
    Write-Warning "These cannot be grepped and will be run in File Mode."
    if ($data.filesWithDynamicTests -and $data.filesWithDynamicTests.Count -gt 0) {
        Write-Step "Files with dynamic tests:"
        foreach ($dynFile in $data.filesWithDynamicTests) {
            Write-Host "    [!] $dynFile" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Step "Impacted Files:"
foreach ($file in $data.files) {
    Write-Host "    [+] $file" -ForegroundColor Gray
}

if ($data.tests -and $data.tests.Count -gt 0) {
    Write-Host ""
    Write-Step "Impacted Tests:"
    foreach ($test in $data.tests) {
        Write-Host "    [+] $test" -ForegroundColor Gray
    }
}

# Execute Playwright
Write-Host ""
$exitCode = 0

# Windows Command Line Limit Handling
# The maximum command line length on Windows is 8191 characters.
# We use a threshold of 7000 to leave room for the base command and other args.
$GREP_LENGTH_THRESHOLD = 7000

# Dynamic Test Handling Strategy:
# If there are files with dynamic tests, they must be run in File Mode.
# We handle this by running in two modes if needed, or falling back entirely to File Mode.
$hasDynamicTests = $data.hasDynamicTests -eq $true
$filesWithDynamic = @()
if ($data.filesWithDynamicTests) {
    $filesWithDynamic = @($data.filesWithDynamicTests)
}

if ($hasDynamicTests -and $filesWithDynamic.Count -gt 0) {
    # Dynamic tests detected - fall back to File Mode for safety
    # Running specific files instead of using grep ensures all tests in those files run
    Write-Warning "Dynamic test names detected. Falling back to File Mode for affected files."
    Write-Host ""
    
    if ($data.files -and $data.files.Count -gt 0) {
        Write-Step "Launching Playwright with impacted files (File Mode due to dynamic tests)..."
        $exitCode = Invoke-PlaywrightWithFiles -Files $data.files -RepoPath $RepoPath
    } else {
        Write-Warning "No files available. Running all tests."
        $exitCode = Invoke-PlaywrightAll -RepoPath $RepoPath
    }
} elseif ($data.grep -and $data.grep.Length -gt 0) {
    # Check if grep pattern exceeds Windows command line limit
    if ($data.grep.Length -gt $GREP_LENGTH_THRESHOLD) {
        Write-Warning "Grep pattern too long ($($data.grep.Length) chars > $GREP_LENGTH_THRESHOLD limit)."
        Write-Warning "Windows Command Line limit is 8191 characters. Falling back to File Mode."
        Write-Host ""
        
        if ($data.files -and $data.files.Count -gt 0) {
            Write-Step "Launching Playwright with impacted files (File Mode)..."
            $exitCode = Invoke-PlaywrightWithFiles -Files $data.files -RepoPath $RepoPath
        } else {
            Write-Warning "No files available for fallback. Running all tests."
            $exitCode = Invoke-PlaywrightAll -RepoPath $RepoPath
        }
    } else {
        Write-Step "Launching Playwright with granular execution (grep filter)..."
        $exitCode = Invoke-PlaywrightWithGrep -GrepPattern $data.grep -RepoPath $RepoPath
    }
} elseif ($data.files -and $data.files.Count -gt 0) {
    Write-Step "Launching Playwright with impacted files..."
    $exitCode = Invoke-PlaywrightWithFiles -Files $data.files -RepoPath $RepoPath
} else {
    Write-Warning "No valid grep pattern or files found. Running all tests."
    $exitCode = Invoke-PlaywrightAll -RepoPath $RepoPath
}

# Final status
Write-Host ""
Write-Host ("=" * 55) -ForegroundColor Cyan

if ($exitCode -eq 0) {
    Write-Success "All tests passed!"
} else {
    Write-Failure "Tests failed with exit code: $exitCode"
}

Write-Host ("=" * 55) -ForegroundColor Cyan

exit $exitCode

#endregion
