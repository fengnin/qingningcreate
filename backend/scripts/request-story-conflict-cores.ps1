[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Idea,

  [ValidateSet('keep-scale', 'grounded-obstacle', 'larger-story', 'genre-led')]
  [string]$ExpansionScope = 'keep-scale',

  [ValidateRange(1, 65535)]
  [int]$Port = 8787
)

Set-StrictMode -Version Latest

$requestBody = [ordered]@{
  idea = $Idea
  expansionScope = $ExpansionScope
} | ConvertTo-Json -Compress

$uri = "http://127.0.0.1:$Port/api/story-conflict-cores"

try {
  $response = Invoke-RestMethod `
    -Method Post `
    -Uri $uri `
    -ContentType 'application/json; charset=utf-8' `
    -Body $requestBody `
    -UseBasicParsing `
    -ErrorAction Stop
} catch {
  if ($_.ErrorDetails.Message) {
    Write-Error $_.ErrorDetails.Message
    exit 1
  }

  throw
}

$response | ConvertTo-Json -Depth 20
