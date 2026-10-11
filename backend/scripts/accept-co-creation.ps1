param(
  [string]$BaseUrl = 'http://127.0.0.1:8787',
  [switch]$RequireSpine,
  [switch]$KeepCreatedSession
)

$ErrorActionPreference = 'Stop'

function Invoke-StoryJson {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body
  )

  $uri = "$BaseUrl$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri
  }
  $json = $Body | ConvertTo-Json -Depth 20
  $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Method $Method -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $jsonBytes
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "FAIL: $Message" }
}

function Invoke-ExpectedError {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body,
    [string]$ExpectedCode
  )

  try {
    Invoke-StoryJson -Method $Method -Path $Path -Body $Body | Out-Null
    throw "Expected $ExpectedCode but request succeeded: $Path"
  } catch {
    if ($_.Exception.Message -like "Expected $ExpectedCode*") { throw }
    $raw = $_.ErrorDetails.Message
    if (-not $raw) { throw }
    $errorBody = $raw | ConvertFrom-Json
    Assert-True ($errorBody.error.code -eq $ExpectedCode) "Expected $ExpectedCode, got $($errorBody.error.code)"
  }
}

$brief = @{
  tones = @('growth')
  dramaticForces = @('contrast')
  allowSystemNamedCharacters = $false
}
$idea = 'A person wants to visit an amusement park.'
$start = Invoke-StoryJson -Method 'POST' -Path '/api/story/co-create/start' -Body @{
  idea = $idea
  brief = $brief
}
$storyId = $start.storyId
$revision = $start.revision
$curveId = $start.curve.id

Assert-True ($start.curve.status -eq 'draft') 'co-create start must return a draft curve'
Assert-True ($null -eq $start.confirmedCurve) 'new sessions cannot be confirmed implicitly'
Assert-True ($start.curve.design.sourceFacts.Count -gt 0) 'source fact ledger must be present'

Invoke-ExpectedError -Method 'POST' -Path '/api/story-spine/turn' -Body @{
  storyId = $storyId
  revision = $revision
  mode = 'start'
  headTailId = 'not-confirmed'
} -ExpectedCode 'STORY_CURVE_NOT_CONFIRMED'

Invoke-ExpectedError -Method 'POST' -Path '/api/story/curve/start-spine' -Body @{
  storyId = $storyId
  revision = $revision
  curveId = $curveId
} -ExpectedCode 'STORY_CURVE_NOT_CONFIRMED'

Invoke-ExpectedError -Method 'POST' -Path '/api/story-predicament' -Body @{
  storyId = $storyId
  revision = $revision
  conflictCoreId = 'not-confirmed'
} -ExpectedCode 'STORY_CURVE_NOT_CONFIRMED'

Invoke-ExpectedError -Method 'POST' -Path '/api/story/action-proposal' -Body @{
  storyId = $storyId
  revision = $revision
  turnId = 'not-confirmed'
  action = 'The character handles the immediate obstacle first.'
} -ExpectedCode 'STORY_CURVE_NOT_CONFIRMED'

Invoke-ExpectedError -Method 'POST' -Path '/api/story-spine/turn-option/refine' -Body @{
  storyId = $storyId
  revision = $revision
  turnId = 'not-confirmed'
  optionId = 'not-confirmed'
  focus = 'action'
  feedback = 'Make this action fit the confirmed story curve.'
} -ExpectedCode 'STORY_CURVE_NOT_CONFIRMED'

$edited = Invoke-StoryJson -Method 'POST' -Path '/api/story/curve/beat' -Body @{
  storyId = $storyId
  revision = $revision
  curveId = $curveId
  beatId = 'beat-trigger'
  detail = 'Author edit: the trigger changes the decision without adding a new person.'
}
$revision = $edited.revision
Assert-True ($edited.curve.beats.Where({ $_.id -eq 'beat-trigger' }).source -eq 'user-edit') 'editing a beat must record author ownership'
Assert-True ($edited.affectedBeatIds.Count -gt 0) 'editing an upstream beat must mark dependents'

$rejected = Invoke-StoryJson -Method 'POST' -Path '/api/story/curve/beat/reject' -Body @{
  storyId = $storyId
  revision = $revision
  curveId = $curveId
  beatId = 'beat-escalation'
  reason = 'This proposal does not fit the intended story.'
}
$revision = $rejected.revision
$rejectedDetail = [string]($rejected.curve.beats.Where({ $_.id -eq 'beat-escalation' }).detail)
Assert-True ($rejected.curve.beats.Where({ $_.id -eq 'beat-escalation' }).status -eq 'rejected') 'rejected proposal must remain visible as rejected'

Invoke-ExpectedError -Method 'POST' -Path '/api/story/curve/beat/regenerate' -Body @{
  storyId = $storyId
  revision = $revision
  curveId = $curveId
  beatId = 'beat-escalation'
} -ExpectedCode 'STORY_CURVE_REJECTED_IMMUTABLE'

$parkFact = $rejected.curve.design.sourceFacts | Select-Object -First 1
if ($parkFact) {
  $parked = Invoke-StoryJson -Method 'POST' -Path '/api/story/curve/source-fact' -Body @{
    storyId = $storyId
    revision = $revision
    curveId = $curveId
    factId = $parkFact.id
    disposition = 'parked'
  }
  $revision = $parked.revision
  Assert-True ($parked.curve.design.sourceFacts.Where({ $_.id -eq $parkFact.id }).disposition -eq 'parked') 'parking a fact must persist explicit author disposition'
}

$snapshot = Invoke-StoryJson -Method 'GET' -Path "/api/story/session/$storyId" -Body $null
Assert-True ($snapshot.curve.id -eq $curveId) 'session snapshot must restore the current curve'
Assert-True ($snapshot.curveVersions.Count -ge 1) 'session snapshot must include curve versions'
Assert-True ($snapshot.revision -eq $revision) 'snapshot revision must match the last mutation'

$confirmationError = $null
try {
  Invoke-StoryJson -Method 'POST' -Path '/api/story/curve/confirm' -Body @{
    storyId = $storyId
    revision = $revision
    curveId = $curveId
  } | Out-Null
  throw 'Expected confirmation to block the deliberately stale draft.'
} catch {
  if ($_.Exception.Message -like 'Expected confirmation to block*') { throw }
  $confirmationError = $_.ErrorDetails.Message | ConvertFrom-Json
  Assert-True ($confirmationError.error.code -eq 'STORY_CURVE_HAS_STALE_BEATS' -or $confirmationError.error.code -eq 'STORY_SOURCE_FACTS_UNRESOLVED') 'confirmation must block unresolved author decisions'
}

# Use a clean session for the positive confirmation, version, author-control,
# and (when requested) role-action checks.
$clean = Invoke-StoryJson -Method 'POST' -Path '/api/story/co-create/start' -Body @{
  idea = $idea
  brief = $brief
}
$cleanId = $clean.storyId
$cleanRevision = $clean.revision
$cleanCurveId = $clean.curve.id
$cleanConfirmed = Invoke-StoryJson -Method 'POST' -Path '/api/story/curve/confirm' -Body @{
  storyId = $cleanId
  revision = $cleanRevision
  curveId = $cleanCurveId
}
$cleanRevision = $cleanConfirmed.revision
Assert-True (-not [string]::IsNullOrWhiteSpace([string]$cleanConfirmed.confirmedCurve.id)) 'a clean draft must be confirmable'

Invoke-ExpectedError -Method 'POST' -Path '/api/story/co-create/start' -Body @{
  storyId = $cleanId
  revision = $cleanRevision
  versionMode = 'replace-draft'
  idea = $idea
  brief = $brief
} -ExpectedCode 'STORY_VERSION_PRESERVATION_REQUIRED'

if ($RequireSpine) {
  $spine = Invoke-StoryJson -Method 'POST' -Path '/api/story/curve/start-spine' -Body @{
    storyId = $cleanId
    revision = $cleanRevision
    curveId = $cleanCurveId
  }
  Assert-True (-not [string]::IsNullOrWhiteSpace([string]$spine.turn.id)) 'confirmed curve must create the first turn'
  Assert-True ($spine.turn.options.Count -gt 0) 'first turn must offer role actions'

  Invoke-ExpectedError -Method 'POST' -Path '/api/story/curve/start-spine' -Body @{
    storyId = $cleanId
    revision = $spine.revision
    curveId = $cleanCurveId
  } -ExpectedCode 'STORY_SPINE_ALREADY_STARTED'

  Invoke-ExpectedError -Method 'POST' -Path '/api/story/action-proposal' -Body @{
    storyId = $cleanId
    revision = $spine.revision
    turnId = $spine.turn.id
    action = 'Change the story genre and remove the current relationship conflict.'
  } -ExpectedCode 'AUTHOR_INSTRUCTION_REQUIRED'

  $proposal = Invoke-StoryJson -Method 'POST' -Path '/api/story/action-proposal' -Body @{
    storyId = $cleanId
    revision = $spine.revision
    turnId = $spine.turn.id
    action = 'The character states the known facts before choosing a next step.'
  }
  Assert-True ($proposal.proposal.turnId -eq $spine.turn.id) 'role action proposal must bind to the current turn'
  $afterProposal = Invoke-StoryJson -Method 'GET' -Path "/api/story/session/$cleanId" -Body $null
  Assert-True ($afterProposal.pendingActionProposal.id -eq $proposal.proposal.id) 'pending role action must survive refresh'
  $cleanRevision = $afterProposal.revision

  Invoke-ExpectedError -Method 'POST' -Path '/api/story/action-proposal' -Body @{
    storyId = $cleanId
    revision = $spine.revision
    turnId = $spine.turn.id
    action = 'The character repeats the known facts before choosing a next step.'
  } -ExpectedCode 'STORY_SESSION_CONFLICT'
}

$authorRevision = Invoke-StoryJson -Method 'POST' -Path '/api/story/author-instruction' -Body @{
  storyId = $cleanId
  revision = $cleanRevision
  targetBeatId = 'beat-trigger'
  text = 'Author revision: make the turn depend on the promise already in the idea.'
}
Assert-True ($authorRevision.curve.status -eq 'draft') 'author instruction must return to draft design'
$cleanRevision = $authorRevision.revision
$afterAuthorRevision = Invoke-StoryJson -Method 'GET' -Path "/api/story/session/$cleanId" -Body $null
Assert-True ($null -eq $afterAuthorRevision.confirmedCurve) 'author revision must clear confirmed status before re-confirmation'
Assert-True ($afterAuthorRevision.history.Count -eq 0) 'author revision must clear the old role-action path'
Assert-True ($null -eq $afterAuthorRevision.currentTurn) 'author revision must clear the old current turn'
$oldConfirmedVersion = $afterAuthorRevision.curveVersions | Where-Object { $_.id -ne $afterAuthorRevision.activeCurveVersionId } | Select-Object -First 1
Assert-True ($null -ne $oldConfirmedVersion.confirmedCurve) 'the saved pre-edit version must retain its confirmed mainline'
$activeDraftVersion = $afterAuthorRevision.curveVersions | Where-Object { $_.id -eq $afterAuthorRevision.activeCurveVersionId } | Select-Object -First 1
Assert-True ($null -eq $activeDraftVersion.confirmedCurve) 'the author-edited active version must not retain stale confirmation metadata'

$newVersion = Invoke-StoryJson -Method 'POST' -Path '/api/story/co-create/start' -Body @{
  storyId = $cleanId
  revision = $cleanRevision
  versionMode = 'new-version'
  idea = $idea
  brief = @{ tones = @('friendship'); dramaticForces = @('relationship-tension'); allowSystemNamedCharacters = $false }
}
Assert-True ($newVersion.curveVersions.Count -ge 2) 'deliberate regeneration must preserve an older version'
$newVersionDetails = @($newVersion.curve.beats | ForEach-Object { [string]$_.detail })
Assert-True (-not ($newVersionDetails -contains $rejectedDetail)) 'a rejected proposal must not silently reappear in a new curve version'
$versionToRestore = $newVersion.curveVersions | Where-Object { $_.id -ne $newVersion.activeCurveVersionId } | Select-Object -First 1
if ($versionToRestore) {
  $restored = Invoke-StoryJson -Method 'POST' -Path '/api/story/curve/version/select' -Body @{
    storyId = $cleanId
    revision = $newVersion.revision
    versionId = $versionToRestore.id
  }
  Assert-True ($restored.activeCurveVersionId -eq $versionToRestore.id) 'version selection must restore the selected path'
}

Write-Output "PASS: co-creation contract checks for $storyId"

if ($KeepCreatedSession) {
  Write-Output "The created session is retained by the API store for manual inspection."
} else {
  Write-Output "The API store retains created sessions; use a fresh test store when isolating runs."
}
