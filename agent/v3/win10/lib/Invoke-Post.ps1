#Requires -Version 5.1
# HTTP POST with retry and offline queue

function Get-QueueFilePath {
    $root = $env:ProgramData
    if ([string]::IsNullOrWhiteSpace($root)) { $root = $env:TEMP }
    $dir = Join-Path $root 'CORAXAgent'
    try { New-Item -ItemType Directory -Path $dir -Force | Out-Null } catch { }
    Join-Path $dir 'pending_report.json'
}

function Save-PendingReport([string]$Json) {
    try {
        $p = Get-QueueFilePath
        [System.IO.File]::WriteAllText($p, $Json, [System.Text.UTF8Encoding]::new($false))
        Log "Saved pending report: $p"
    } catch { }
}

function Load-PendingReport {
    try {
        $p = Get-QueueFilePath
        if (Test-Path -LiteralPath $p) {
            return [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
        }
    } catch { }
    return $null
}

function Clear-PendingReport {
    try {
        $p = Get-QueueFilePath
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    } catch { }
}

function Get-InventoryUriCandidates {
    param([string]$BaseUrl)
    $u = [Uri]$BaseUrl
    $ports = [System.Collections.Generic.List[int]]::new()
    if ($u.Port -gt 0) {
        $urlPort = [int]$u.Port
        if ($urlPort -eq 3250 -and -not $ports.Contains(3001)) { [void]$ports.Add(3001) }
        if (-not $ports.Contains($urlPort)) { [void]$ports.Add($urlPort) }
    }
    foreach ($p in @(3001, 3250, 3000)) {
        if (-not $ports.Contains([int]$p)) { [void]$ports.Add([int]$p) }
    }
    $paths = @('/api/v1/agent/inventory', '/api/agent/inventory')
    $seen = @{}
    $list = [System.Collections.Generic.List[object]]::new()
    foreach ($port in $ports) {
        $builder = New-Object System.UriBuilder($u.Scheme, $u.Host, $port)
        $candidateBase = $builder.Uri.GetLeftPart([System.UriPartial]::Authority)
        foreach ($path in $paths) {
            $candidateUri = $candidateBase.TrimEnd('/') + $path
            $key = $candidateUri.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            [void]$list.Add([pscustomobject]@{ Uri = $candidateUri; Host = $u.Host; Port = $port })
        }
    }
    @($list.ToArray())
}

function Invoke-InventoryPost {
    param([string]$Uri, [string]$Json, [string]$Token)
    $backoff = @(2, 5, 15)
    for ($i = 0; $i -lt ($backoff.Count + 1); $i++) {
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.UseProxy = $false
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(90)
        [void]$client.DefaultRequestHeaders.TryAddWithoutValidation('Authorization', "Bearer $Token")
        $content = New-Object System.Net.Http.StringContent($Json, [System.Text.UTF8Encoding]::new($false), 'application/json')
        try {
            $response = $client.PostAsync($Uri, $content).GetAwaiter().GetResult()
            $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if ($response.IsSuccessStatusCode) {
                return @{ ok = $true; body = $body }
            }
            $code = [int]$response.StatusCode
            if ($code -ge 500 -and $i -lt $backoff.Count) {
                Start-Sleep -Seconds $backoff[$i]
                continue
            }
            return @{ ok = $false; body = $body; code = $code }
        } catch {
            if ($i -lt $backoff.Count) {
                Start-Sleep -Seconds $backoff[$i]
                continue
            }
            throw $_.Exception
        } finally {
            if ($client) { $client.Dispose() }
            if ($handler) { $handler.Dispose() }
        }
    }
    return @{ ok = $false; body = '' }
}

function Send-InventoryReport {
    param([hashtable]$Payload, [string]$BaseUrl, [string]$Token)
    try {
        $names = [enum]::GetNames([Net.SecurityProtocolType])
        if ($names -contains 'Tls12') {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        }
    } catch { }

    Add-Type -AssemblyName System.Net.Http

    $json = ($Payload | ConvertTo-Json -Depth 12 -Compress)
    Log ("JSON size: {0} bytes" -f $json.Length)

    $candidates = @(Get-InventoryUriCandidates -BaseUrl $BaseUrl)
    Log ("POST target base: $BaseUrl")

    $pending = Load-PendingReport
    if ($pending) {
        Log 'Sending pending report from previous run...'
        foreach ($c in $candidates) {
            try {
                $r0 = Invoke-InventoryPost -Uri $c.Uri -Json $pending -Token $Token
                if ($r0.ok) { Clear-PendingReport; Log 'Pending report sent.'; break }
            } catch { }
        }
    }

    foreach ($c in $candidates) {
        Log "HTTP POST $($c.Uri) ..."
        try {
            $r = Invoke-InventoryPost -Uri $c.Uri -Json $json -Token $Token
            if ($r.ok) {
                Log "HTTP OK: $($r.body)"
                return 0
            }
            Log "HTTP FAIL: $($r.code) $($r.body)"
        } catch {
            Log "HTTP ERROR: $($_.Exception.Message)"
        }
    }

    Save-PendingReport -Json $json
    return 1
}
