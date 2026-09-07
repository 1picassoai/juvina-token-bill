# report-collision.ps1 - Galahad, 7 Sep 2026.
#
# WHY THIS EXISTS: the report card writes to a FIXED filename in the current directory. If a file of
# that name is already there, it is replaced - no warning, no prompt, no backup. I proved this on
# 7 Sep, and I had already caused it: on 6 Sep I ran the tool from the Captain's directory and
# destroyed his report card.
#
# For general use that is a footgun. Under @Fox's proposal #5 it is a BLOCKER, and his reasoning is
# better than my original "not a blocker": #5 walks into a code-reading community saying "audit us -
# zero deps, no network calls, 4 files, read it in five minutes". The first person who takes that
# invitation seriously and loses a file writes the issue titled "this overwrote my file without
# asking", and THAT thread becomes our introduction to the audience we most need.
# Inviting an audit and then failing it is a worse fault than never inviting one.
#
# This test was written BEFORE the fix, so it is a real test and not a description of whatever the
# code ended up doing. It must FAIL on today's code and PASS on the fix.
#
#   .\report-collision.ps1                     # walks the published npx path (what a stranger runs)
#   .\report-collision.ps1 -Local ..\index.js  # walks a local build, for the fix loop
#
# Exit 0 = a stranger's file is safe. Exit 1 = it is not.

param(
    [string]$Local,
    [string]$Pkg = 'github:1picassoai/juvina-token-bill'
)

$ErrorActionPreference = 'Continue'
$results = @()
function Check($id, $name, $pass, $detail) {
    $script:results += [pscustomobject]@{ id = $id; name = $name; pass = [bool]$pass; detail = $detail }
    Write-Host ("{0}  {1,-6} {2}" -f $(if ($pass) { "PASS" } else { "FAIL" }), $id, $name)
    Write-Host ("          {0}" -f $detail)
}

$CARD = 'juvina-token-bill-report.html'
function New-Box {
    $b = Join-Path $env:TEMP ("gal-collision-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $b -Force | Out-Null
    return $b
}
function Invoke-Tool($box) {
    Push-Location $box
    try {
        if ($Local) { & node (Resolve-Path $Local) 2>&1 | Out-Null }
        else { & npx -y $Pkg 2>&1 | Out-Null }
    } catch { } finally { Pop-Location }
}

Write-Host "`n=== report-card collision: does a stranger keep their file? ===`n"
Write-Host ("target: {0}`n" -f $(if ($Local) { "local $Local" } else { "published $Pkg" }))

# --- c01 NEGATIVE CONTROL: with no pre-existing file, the tool must still work ------------------
# Without this, every assertion below could pass simply because the tool never ran. A battery that
# cannot tell "safe" from "broken" is not a battery.
$box = New-Box
Invoke-Tool $box
$made = Test-Path (Join-Path $box $CARD)
Check "c01" "control: writes its card normally in an empty directory" $made `
      $(if ($made) { "card written - the tool ran, so the checks below mean something" }
        else { "NO CARD WRITTEN - tool did not run; every result below is vacuous" })

if (-not $made) {
    Write-Host "`n==== ABORTED: control failed, results would be meaningless ====" -ForegroundColor Yellow
    exit 1
}

# --- c02 THE FAULT: a pre-existing file of that name must survive -------------------------------
$box = New-Box
$victim = Join-Path $box $CARD
$sentinel = "STRANGER'S OWN FILE - must survive - $([Guid]::NewGuid())"
Set-Content $victim $sentinel -Encoding utf8
Invoke-Tool $box
$after = (Get-Content $victim -Raw -ErrorAction SilentlyContinue)
$survived = $after -and $after.Contains($sentinel)
Check "c02" "a pre-existing file of that name is NOT overwritten" $survived `
      $(if ($survived) { "sentinel intact - the stranger keeps their file" }
        else { "OVERWRITTEN - the stranger's file is gone, silently" })

# --- c03 the report still has to be produced SOMEWHERE, under another name ----------------------
# The fix must not be "skip the report" - that trades a data-loss bug for a silent-failure bug,
# which is the fault I reported on 6 Sep. It must write, elsewhere, and say where.
$others = @(Get-ChildItem $box -Filter 'juvina-token-bill-report*.html' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne $CARD })
$tmpCards = @(Get-ChildItem $env:TEMP -Filter 'juvina-token-bill-report*.html' -ErrorAction SilentlyContinue |
              Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-2) })
$wroteElsewhere = ($others.Count -gt 0) -or ($tmpCards.Count -gt 0)
Check "c03" "the card is still produced under a different name" $wroteElsewhere `
      $(if ($others.Count) { "wrote $($others[0].Name) alongside the stranger's file" }
        elseif ($tmpCards.Count) { "fell back to tmpdir - acceptable, the path is printed" }
        elseif (-not $survived) { "no second card - EXPECTED on unfixed code, which overwrites in place rather than renaming. Re-read after the fix: then this means the report was suppressed instead of renamed." }
        else { "NO CARD ANYWHERE - the report was suppressed instead of renamed" })

# --- c04 repeated runs must not fight each other -------------------------------------------------
# A stranger running it twice in the same directory is the common case, not an edge case.
$box = New-Box
Invoke-Tool $box
Invoke-Tool $box
$cards = @(Get-ChildItem $box -Filter 'juvina-token-bill-report*.html' -ErrorAction SilentlyContinue)
Check "c04" "two runs in one directory leave a usable result" ($cards.Count -ge 1) `
      "$($cards.Count) card(s) after two runs: $(($cards | Select-Object -First 3 | ForEach-Object Name) -join ', ')"

$fails = @($results | Where-Object { -not $_.pass })
Write-Host ("`n==== {0}/{1} passed ====" -f ($results.Count - $fails.Count), $results.Count)
if ($fails.Count) {
    Write-Host "`nFAILED:"
    $fails | ForEach-Object { Write-Host ("  {0}  {1}" -f $_.id, $_.name) }
    Write-Host "`nA stranger's file is at risk. Under proposal #5 this blocks the first post."
}
exit ([int]($fails.Count -gt 0))
