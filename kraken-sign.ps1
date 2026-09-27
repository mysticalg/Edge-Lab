$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1" -Force
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -Force
$secretBytes = $null
$secretValue = $null
$keyValue = $null
$secretPtr = [IntPtr]::Zero
$keyPtr = [IntPtr]::Zero
$stage = 'input'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.path -notin @('/0/private/Balance', '/0/private/BalanceEx', '/0/private/TradeVolume', '/0/private/GetApiKeyInfo', '/0/private/AddOrder', '/0/private/OpenOrders', '/0/private/ClosedOrders', '/0/private/QueryOrders')) { throw 'Unsupported endpoint' }
  $storeDirectory = Join-Path $env:LOCALAPPDATA 'EdgeLab'
  $stage = 'decrypt'
  $secretValue = Get-Content -LiteralPath (Join-Path $storeDirectory 'kraken-api-secret.dpapi') -Raw | ConvertTo-SecureString
  $keyValue = Get-Content -LiteralPath (Join-Path $storeDirectory 'kraken-api-key.dpapi') -Raw | ConvertTo-SecureString
  $secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretValue)
  $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($keyValue)
  $secretBytes = [Convert]::FromBase64String([Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr))
  $stage = 'hash'
  $hasher = [Security.Cryptography.SHA256]::Create()
  $digest = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$request.nonce + [string]$request.payload))
  $hasher.Dispose()
  $hmac = New-Object Security.Cryptography.HMACSHA512
  $stage = 'hmac'
  $hmac.Key = $secretBytes
  $signedBytes = [Text.Encoding]::UTF8.GetBytes([string]$request.path) + $digest
  $signature = [Convert]::ToBase64String($hmac.ComputeHash($signedBytes))
  $hmac.Dispose()
  $stage = 'response'
  @{ apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr); signature = $signature } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('Credential helper failed at ' + $stage + ' (' + $_.Exception.GetType().Name + ', line ' + $_.InvocationInfo.ScriptLineNumber + ')')
  exit 1
} finally {
  if ($secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
  if ($secretPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr) }
  if ($keyPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr) }
  if ($secretValue) { $secretValue.Dispose() }
  if ($keyValue) { $keyValue.Dispose() }
}
