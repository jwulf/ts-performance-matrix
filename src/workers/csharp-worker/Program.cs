// C# worker for the performance matrix.
//
// Uses the Camunda.Orchestration.Sdk NuGet package to poll for and complete jobs.
//
// Environment variables (same protocol as TS worker):
//   WORKER_PROCESS_ID, SDK_MODE (always "rest"), HANDLER_TYPE, HANDLER_LATENCY_MS,
//   NUM_WORKERS, TARGET_PER_WORKER, ACTIVATE_BATCH, PAYLOAD_SIZE_KB,
//   SCENARIO_TIMEOUT_S, BROKER_REST_URL, RESULT_FILE, READY_FILE, GO_FILE

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Camunda.Orchestration.Sdk;
using Camunda.Orchestration.Sdk.Runtime;

// ─── Config ──────────────────────────────────────────────

var PROCESS_ID = Env("WORKER_PROCESS_ID", "process-0");
var SDK_MODE = Env("SDK_MODE", "rest");
var HANDLER_TYPE = Env("HANDLER_TYPE", "cpu");
var HANDLER_LATENCY_MS = EnvInt("HANDLER_LATENCY_MS", 200);
var NUM_WORKERS = EnvInt("NUM_WORKERS", 1);
var TARGET_PER_WORKER = EnvInt("TARGET_PER_WORKER", 10000);
var ACTIVATE_BATCH = EnvInt("ACTIVATE_BATCH", 32);
var SCENARIO_TIMEOUT_S = EnvInt("SCENARIO_TIMEOUT_S", 300);
var BROKER_REST_URL = Env("BROKER_REST_URL", "http://localhost:8080").TrimEnd('/');
var RESULT_FILE = Env("RESULT_FILE", "./result.json");
var READY_FILE = Env("READY_FILE", "");
var GO_FILE = Env("GO_FILE", "");

// Configure SDK via env vars
Environment.SetEnvironmentVariable("CAMUNDA_REST_ADDRESS", BROKER_REST_URL);
Environment.SetEnvironmentVariable("CAMUNDA_AUTH_STRATEGY", "NONE");

// ─── Producer mode (--produce) ───────────────────────────
if (args.Length > 0 && args[0] == "--produce")
{
    await RunProducer();
    return;
}

var jsonOpts = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    WriteIndented = true,
};

// ─── Error type aggregation ──────────────────────────────

var errorTypes = new ConcurrentDictionary<string, int>();

static string ErrorKey(Exception ex)
{
    var cause = ex;
    while (cause.InnerException != null) cause = cause.InnerException;
    var name = cause.GetType().Name;
    var msg = cause.Message ?? "";
    if (msg.Length > 120) msg = msg[..120];
    return string.IsNullOrEmpty(msg) ? name : $"{name}: {msg}";
}

try
{
    Console.WriteLine($"[csharp-worker] id={PROCESS_ID} mode={SDK_MODE} handler={HANDLER_TYPE} workers={NUM_WORKERS}");
    Console.WriteLine($"[csharp-worker] target={TARGET_PER_WORKER}/worker broker={BROKER_REST_URL}");

    // Start HTTP sim server if needed
    int httpSimPort = 0;
    CancellationTokenSource? simCts = null;
    if (HANDLER_TYPE == "http" && HANDLER_LATENCY_MS > 0)
    {
        simCts = new CancellationTokenSource();
        httpSimPort = await StartHttpSimServer(HANDLER_LATENCY_MS, simCts.Token);
    }

    // Signal ready (barrier protocol)
    WriteReady(READY_FILE);
    await WaitForGo(GO_FILE);

    Console.WriteLine("[csharp-worker] GO received, starting benchmark...");

    var memSampler = new MemorySampler();
    memSampler.Start();

    var (workerCompleted, workerErrors, wallClockS) = await RunRest(httpSimPort);

    simCts?.Cancel();

    var totalCompleted = workerCompleted.Sum();
    var totalErrors = workerErrors.Sum();
    var throughput = wallClockS > 0 ? totalCompleted / wallClockS : 0;
    var perWorkerThroughputs = workerCompleted.Select(c => wallClockS > 0 ? c / wallClockS : 0).ToArray();

    // Sort errorTypes by count descending
    var sortedErrorTypes = errorTypes
        .OrderByDescending(kv => kv.Value)
        .ToDictionary(kv => kv.Key, kv => kv.Value);

    var memoryUsage = memSampler.Stop();

    var output = new ResultOutput
    {
        ProcessId = PROCESS_ID,
        SdkMode = SDK_MODE,
        HandlerType = HANDLER_TYPE,
        WorkersInProcess = NUM_WORKERS,
        TotalCompleted = totalCompleted,
        TotalErrors = totalErrors,
        WallClockS = wallClockS,
        Throughput = throughput,
        PerWorkerCompleted = workerCompleted,
        PerWorkerErrors = workerErrors,
        PerWorkerThroughputs = perWorkerThroughputs,
        ErrorTypes = sortedErrorTypes,
        MemoryUsage = memoryUsage,
    };

    var errorTypeCount = sortedErrorTypes.Count;
    Console.WriteLine($"[csharp-worker] Done: {totalCompleted} completed, {totalErrors} errors ({errorTypeCount} types), {throughput:F1} ops/s");
    if (errorTypeCount > 0)
    {
        foreach (var (key, count) in sortedErrorTypes.Take(5))
            Console.WriteLine($"[csharp-worker]   {count}× {key}");
    }

    await File.WriteAllTextAsync(RESULT_FILE, JsonSerializer.Serialize(output, jsonOpts));
    Console.WriteLine($"[csharp-worker] Result written to {RESULT_FILE}");
}
catch (Exception ex)
{
    Console.Error.WriteLine($"[csharp-worker] Fatal error: {ex}");

    var errorOutput = new ResultOutput
    {
        ProcessId = PROCESS_ID,
        SdkMode = SDK_MODE,
        HandlerType = HANDLER_TYPE,
        WorkersInProcess = NUM_WORKERS,
        TotalCompleted = 0,
        TotalErrors = 0,
        WallClockS = 0,
        Throughput = 0,
        PerWorkerCompleted = [],
        PerWorkerErrors = [],
        PerWorkerThroughputs = [],
        Error = ex.Message,
    };

    await File.WriteAllTextAsync(RESULT_FILE, JsonSerializer.Serialize(errorOutput, jsonOpts));
    Environment.Exit(1);
}

// ─── REST worker (SDK-based) ─────────────────────────────

async Task<(int[] completed, int[] errors, double wallClockS)> RunRest(int httpSimPort)
{
    var totalTarget = NUM_WORKERS * TARGET_PER_WORKER;
    var workerCompleted = new int[NUM_WORKERS];
    var workerErrors = new int[NUM_WORKERS];
    var done = 0; // 0=false, 1=true (for Interlocked)

    using var httpSimClient = HANDLER_TYPE == "http" && httpSimPort > 0
        ? new HttpClient { Timeout = TimeSpan.FromSeconds(10) }
        : null;

    await using var client = new CamundaClient();

    var config = new JobWorkerConfig
    {
        JobType = "test-job",
        JobTimeoutMs = 30000,
        MaxConcurrentJobs = ACTIVATE_BATCH * NUM_WORKERS,
    };

    client.CreateJobWorker(config, async (job, ct) =>
    {
        try
        {
            // Simulate work
            if (HANDLER_TYPE == "cpu" && HANDLER_LATENCY_MS > 0)
                CpuWork(HANDLER_LATENCY_MS);
            else if (HANDLER_TYPE == "http" && httpSimClient != null)
                await httpSimClient.GetAsync($"http://127.0.0.1:{httpSimPort}/work", ct);

            // Round-robin metric tracking
            var minIdx = MinIndex(workerCompleted);
            Interlocked.Increment(ref workerCompleted[minIdx]);
            var total = workerCompleted.Sum();
            if (total >= totalTarget)
                Interlocked.Exchange(ref done, 1);

            return new { done = true };
        }
        catch (Exception ex)
        {
            var minErrIdx = MinIndex(workerErrors);
            Interlocked.Increment(ref workerErrors[minErrIdx]);
            errorTypes.AddOrUpdate(ErrorKey(ex), 1, (_, c) => c + 1);
            throw;
        }
    });

    var cts = new CancellationTokenSource(TimeSpan.FromSeconds(SCENARIO_TIMEOUT_S));
    var sw = Stopwatch.StartNew();

    // Run workers in background — blocks until cancellation
    var workerTask = client.RunWorkersAsync(ct: cts.Token);

    // Poll for completion
    while (Volatile.Read(ref done) == 0 && !cts.Token.IsCancellationRequested)
        await Task.Delay(50);

    // Stop workers gracefully
    cts.Cancel();
    await workerTask;

    sw.Stop();
    return (workerCompleted, workerErrors, sw.Elapsed.TotalSeconds);
}

// ─── CPU work simulation ─────────────────────────────────

static void CpuWork(int durationMs)
{
    if (durationMs <= 0) return;
    var end = Stopwatch.GetTimestamp() + (long)(durationMs / 1000.0 * Stopwatch.Frequency);
    double x = 0;
    while (Stopwatch.GetTimestamp() < end)
        x += Math.Sin(x + 1);
}

// ─── HTTP sim server ─────────────────────────────────────

static async Task<int> StartHttpSimServer(int latencyMs, CancellationToken ct)
{
    var listener = new HttpListener();
    listener.Prefixes.Add("http://127.0.0.1:0/");
    // HttpListener doesn't support port 0 well — use TcpListener to find a free port
    var tcp = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
    tcp.Start();
    var port = ((IPEndPoint)tcp.LocalEndpoint).Port;
    tcp.Stop();

    listener = new HttpListener();
    listener.Prefixes.Add($"http://127.0.0.1:{port}/");
    listener.Start();

    _ = Task.Run(async () =>
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var ctx = await listener.GetContextAsync();
                _ = Task.Run(async () =>
                {
                    await Task.Delay(latencyMs, CancellationToken.None);
                    ctx.Response.StatusCode = 200;
                    ctx.Response.ContentType = "application/json";
                    await using var sw = new StreamWriter(ctx.Response.OutputStream);
                    await sw.WriteAsync("{\"ok\":true}");
                    ctx.Response.Close();
                });
            }
            catch (ObjectDisposedException) { break; }
            catch (HttpListenerException) { break; }
        }
        listener.Close();
    }, ct);

    await Task.Delay(50, CancellationToken.None); // let server start
    return port;
}

// ─── Barrier protocol ────────────────────────────────────

static void WriteReady(string readyFile)
{
    if (string.IsNullOrEmpty(readyFile)) return;
    var dir = Path.GetDirectoryName(readyFile);
    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    File.WriteAllText(readyFile, "1");
}

static async Task WaitForGo(string goFile)
{
    if (string.IsNullOrEmpty(goFile)) return;
    while (!File.Exists(goFile))
        await Task.Delay(10);
}

// ─── Helpers ─────────────────────────────────────────────

static string Env(string name, string defaultValue) =>
    Environment.GetEnvironmentVariable(name) ?? defaultValue;

static int EnvInt(string name, int defaultValue) =>
    int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : defaultValue;

static int MinIndex(int[] arr)
{
    var minIdx = 0;
    for (var i = 1; i < arr.Length; i++)
        if (arr[i] < arr[minIdx]) minIdx = i;
    return minIdx;
}

// ─── Producer logic ──────────────────────────────────────

async Task RunProducer()
{
    var bpmnPath = Env("BPMN_PATH", "");
    var precreateCount = EnvInt("PRECREATE_COUNT", 0);
    var payloadSizeKb = EnvInt("PAYLOAD_SIZE_KB", 10);
    var concurrency = 200;
    var continuous = Env("CONTINUOUS", "0") == "1";
    var readyFile = Env("READY_FILE", "");
    var goFile = Env("GO_FILE", "");
    var stopFile = Env("STOP_FILE", "");
    var statsFile = Env("PRODUCER_STATS_FILE", "");
    var precreateStatsFile = Env("PRECREATE_STATS_FILE", "");

    if (string.IsNullOrEmpty(bpmnPath))
    {
        Console.Error.WriteLine("[csharp-producer] BPMN_PATH not set");
        Environment.Exit(1);
    }

    Console.WriteLine($"[csharp-producer] broker={BROKER_REST_URL} bpmn={bpmnPath} precreate={precreateCount} continuous={continuous}");

    await using var client = new CamundaClient();

    // Deploy
    Console.WriteLine("[csharp-producer] Deploying process...");
    var deployment = await client.DeployResourcesFromFilesAsync(new[] { bpmnPath });
    var processDefKey = deployment.Processes[0].ProcessDefinitionKey;
    Console.WriteLine($"[csharp-producer] Deployed: {processDefKey}");

    // Wait for deployment propagation
    await Task.Delay(10_000);

    // Build payload
    var rng = new Random();
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var payload = new string(Enumerable.Range(0, payloadSizeKb * 1024).Select(_ => chars[rng.Next(chars.Length)]).ToArray());

    // Phase 1: pre-create buffer
    if (precreateCount > 0)
    {
        var created = 0;
        var errors = 0;
        var sem = new SemaphoreSlim(concurrency);
        var sw = Stopwatch.StartNew();
        var lastLog = sw.Elapsed;

        Console.WriteLine($"[csharp-producer] pre-create: creating {precreateCount} instances...");

        var tasks = new List<Task>();
        for (int i = 0; i < precreateCount; i++)
        {
            await sem.WaitAsync();
            tasks.Add(Task.Run(async () =>
            {
                try
                {
                    await client.CreateProcessInstanceAsync(
                        new Camunda.Orchestration.Sdk.Api.ProcessInstanceCreationInstructionByKey
                        {
                            ProcessDefinitionKey = processDefKey,
                            Variables = new { data = payload },
                        });
                    Interlocked.Increment(ref created);
                }
                catch
                {
                    Interlocked.Increment(ref errors);
                }
                finally
                {
                    sem.Release();
                }

                if (sw.Elapsed - lastLog > TimeSpan.FromSeconds(10))
                {
                    var elapsed = (int)sw.Elapsed.TotalSeconds;
                    var rate = (int)(created / sw.Elapsed.TotalSeconds);
                    Console.WriteLine($"[csharp-producer] pre-create: {created + errors}/{precreateCount} ({created} ok, {errors} err) {elapsed}s, ~{rate}/s");
                    lastLog = sw.Elapsed;
                }
            }));
        }

        await Task.WhenAll(tasks);
        Console.WriteLine($"[csharp-producer] pre-create: done {created} created, {errors} errors in {sw.Elapsed.TotalSeconds:F1}s");

        if (!string.IsNullOrEmpty(precreateStatsFile))
        {
            var pcStats = $"{{\"created\":{created},\"errors\":{errors},\"durationS\":{sw.Elapsed.TotalSeconds:F1}}}";
            await File.WriteAllTextAsync(precreateStatsFile, pcStats);
            Console.WriteLine($"[csharp-producer] Pre-create stats written to {precreateStatsFile}");
        }
    }

    // Signal ready
    if (!string.IsNullOrEmpty(readyFile))
    {
        await File.WriteAllTextAsync(readyFile, "1");
        Console.WriteLine($"[csharp-producer] Ready signal written to {readyFile}");
    }

    if (!continuous)
    {
        Console.WriteLine("[csharp-producer] Done (no continuous mode).");
        return;
    }

    // Wait for GO
    if (!string.IsNullOrEmpty(goFile))
    {
        Console.WriteLine($"[csharp-producer] Waiting for GO file: {goFile}");
        while (!File.Exists(goFile))
        {
            await Task.Delay(100);
        }
        Console.WriteLine("[csharp-producer] GO received, starting continuous production...");
    }

    // Phase 2: continuous production
    var contCreated = 0;
    var contErrors = 0;
    var contSem = new SemaphoreSlim(concurrency);
    var contSw = Stopwatch.StartNew();
    var contLastLog = contSw.Elapsed;

    Console.WriteLine($"[csharp-producer] continuous: starting (concurrency={concurrency})...");

    while (string.IsNullOrEmpty(stopFile) || !File.Exists(stopFile))
    {
        await contSem.WaitAsync();
        _ = Task.Run(async () =>
        {
            try
            {
                await client.CreateProcessInstanceAsync(
                    new Camunda.Orchestration.Sdk.Api.ProcessInstanceCreationInstructionByKey
                    {
                        ProcessDefinitionKey = processDefKey,
                        Variables = new { data = payload },
                    });
                Interlocked.Increment(ref contCreated);
            }
            catch
            {
                Interlocked.Increment(ref contErrors);
            }
            finally
            {
                contSem.Release();
            }
        });

        if (contSw.Elapsed - contLastLog > TimeSpan.FromSeconds(10))
        {
            var elapsed = (int)contSw.Elapsed.TotalSeconds;
            var rate = contSw.Elapsed.TotalSeconds > 0 ? (int)(contCreated / contSw.Elapsed.TotalSeconds) : 0;
            Console.WriteLine($"[csharp-producer] continuous: {contCreated} ok, {contErrors} err, {elapsed}s, ~{rate}/s");
            contLastLog = contSw.Elapsed;
        }
    }

    // Wait for inflight to drain
    for (int i = 0; i < concurrency; i++) await contSem.WaitAsync();

    var contDuration = contSw.Elapsed.TotalSeconds;
    var contRate = contDuration > 0 ? contCreated / contDuration : 0;
    Console.WriteLine($"[csharp-producer] continuous: stopped. {contCreated} created, {contErrors} errors in {contDuration:F1}s (~{contRate:F0}/s)");

    if (!string.IsNullOrEmpty(statsFile))
    {
        var statsJson = $"{{\"created\":{contCreated},\"errors\":{contErrors},\"durationS\":{contDuration:F1},\"rate\":{contRate:F1}}}";
        await File.WriteAllTextAsync(statsFile, statsJson);
        Console.WriteLine($"[csharp-producer] continuous: stats written to {statsFile}");
    }
}

// ─── Models ──────────────────────────────────────────────

class ResultOutput
{
    public string ProcessId { get; set; } = "";
    public string SdkMode { get; set; } = "";
    public string HandlerType { get; set; } = "";
    public int WorkersInProcess { get; set; }
    public int TotalCompleted { get; set; }
    public int TotalErrors { get; set; }
    public double WallClockS { get; set; }
    public double Throughput { get; set; }
    public int[] PerWorkerCompleted { get; set; } = [];
    public int[] PerWorkerErrors { get; set; } = [];
    public double[] PerWorkerThroughputs { get; set; } = [];
    public string? Error { get; set; }
    public Dictionary<string, int>? ErrorTypes { get; set; }
    public MemoryUsageOutput? MemoryUsage { get; set; }
}

class MemoryUsageOutput
{
    public double PeakRssMb { get; set; }
    public double AvgRssMb { get; set; }
    public int Samples { get; set; }
}

class MemorySampler
{
    private readonly List<long> _samples = new();
    private readonly object _lock = new();
    private volatile bool _running;
    private Thread? _thread;

    public void Start()
    {
        _running = true;
        // Take initial sample
        lock (_lock) { _samples.Add(Process.GetCurrentProcess().WorkingSet64); }
        _thread = new Thread(Run) { IsBackground = true, Name = "mem-sampler" };
        _thread.Start();
    }

    private void Run()
    {
        while (_running)
        {
            Thread.Sleep(5000);
            if (!_running) break;
            lock (_lock) { _samples.Add(Process.GetCurrentProcess().WorkingSet64); }
        }
    }

    public MemoryUsageOutput Stop()
    {
        _running = false;
        _thread?.Join(2000);
        // Take final sample
        lock (_lock) { _samples.Add(Process.GetCurrentProcess().WorkingSet64); }

        long peak = 0, sum = 0;
        lock (_lock)
        {
            foreach (var s in _samples)
            {
                if (s > peak) peak = s;
                sum += s;
            }
        }
        var count = _samples.Count;
        return new MemoryUsageOutput
        {
            PeakRssMb = Math.Round(peak / (1024.0 * 1024.0), 1),
            AvgRssMb = Math.Round(count > 0 ? sum / (double)count / (1024.0 * 1024.0) : 0, 1),
            Samples = count,
        };
    }
}
