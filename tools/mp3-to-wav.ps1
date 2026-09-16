# Dev-time only. Transcodes an audio file to PCM WAV using Windows Media Foundation,
# so a WAV test asset can be produced without adding a dependency. Windows PowerShell 5.1
# only: PowerShell 7 does not project WinRT types.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'

$source = (Resolve-Path -LiteralPath $Source).Path
$destDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($Destination))
$destName = Split-Path -Leaf $Destination

Add-Type -AssemblyName System.Runtime.WindowsRuntime

[void][Windows.Media.Transcoding.MediaTranscoder, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await-Op($operation, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}

function Await-Action($action) {
  # TranscodeAsync returns IAsyncActionWithProgress<double>, which has its own AsTask overload.
  $method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1'
    })[0]
  $task = $method.MakeGenericMethod([double]).Invoke($null, @($action))
  $task.Wait(-1) | Out-Null
  if ($task.IsFaulted) { throw $task.Exception }
}

$inFile = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($source)) ([Windows.Storage.StorageFile])
$outFolder = Await-Op ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($destDir)) ([Windows.Storage.StorageFolder])
$outFile = Await-Op ($outFolder.CreateFileAsync($destName, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])

$profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateWav(
  [Windows.Media.MediaProperties.AudioEncodingQuality]::High)

$transcoder = New-Object Windows.Media.Transcoding.MediaTranscoder
$prepared = Await-Op ($transcoder.PrepareFileTranscodeAsync($inFile, $outFile, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])

if (-not $prepared.CanTranscode) {
  throw "cannot transcode: $($prepared.FailureReason)"
}

Await-Action $prepared.TranscodeAsync()
Write-Output "wrote $Destination"
