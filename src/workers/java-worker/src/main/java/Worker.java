/**
 * Java worker for the performance matrix.
 *
 * Uses io.camunda:camunda-client-java SDK for both REST and gRPC modes.
 *
 * Environment variables (same protocol as TS worker):
 *   WORKER_PROCESS_ID, SDK_MODE (rest|grpc-streaming|grpc-polling), HANDLER_TYPE, HANDLER_LATENCY_MS,
 *   NUM_WORKERS, TARGET_PER_WORKER, ACTIVATE_BATCH, PAYLOAD_SIZE_KB,
 *   SCENARIO_TIMEOUT_S, BROKER_REST_URL, BROKER_GRPC_URL, RESULT_FILE, READY_FILE, GO_FILE
 */

import io.camunda.client.CamundaClient;
import io.camunda.client.api.worker.JobWorker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicIntegerArray;

public class Worker {

    // ─── Config ──────────────────────────────────────────────

    static final String PROCESS_ID = env("WORKER_PROCESS_ID", "process-0");
    static final String SDK_MODE = env("SDK_MODE", "rest");
    static final String HANDLER_TYPE = env("HANDLER_TYPE", "cpu");
    static final int HANDLER_LATENCY_MS = envInt("HANDLER_LATENCY_MS", 20);
    static final int NUM_WORKERS = envInt("NUM_WORKERS", 1);
    static final int TARGET_PER_WORKER = envInt("TARGET_PER_WORKER", 10000);
    static final int ACTIVATE_BATCH = envInt("ACTIVATE_BATCH", 32);
    static final int SCENARIO_TIMEOUT_S = envInt("SCENARIO_TIMEOUT_S", 300);
    static final String BROKER_REST_URL = env("BROKER_REST_URL", "http://localhost:8080").replaceAll("/+$", "");
    static final String BROKER_GRPC_URL = env("BROKER_GRPC_URL", "localhost:26500");
    static final String RESULT_FILE = env("RESULT_FILE", "./result.json");
    static final String READY_FILE = env("READY_FILE", "");
    static final String GO_FILE = env("GO_FILE", "");

    // Aggregator-based pool exhaustion detection
    static final String AGGREGATOR_URL = env("AGGREGATOR_URL", "");
    static volatile boolean aggregatorStop = false;
    static long lastHeartbeatNanos = 0;
    static final long HEARTBEAT_INTERVAL_NS = 2_000_000_000L; // 2s

    static void checkAggregatorStop(long t0Nanos, int totalCompleted) {
        if (AGGREGATOR_URL.isEmpty()) return;
        long now = System.nanoTime();
        if (now - lastHeartbeatNanos < HEARTBEAT_INTERVAL_NS) return;
        lastHeartbeatNanos = now;
        try {
            var url = new java.net.URL(AGGREGATOR_URL + "/heartbeat");
            var conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            conn.setConnectTimeout(1000);
            conn.setReadTimeout(1000);
            var body = String.format("{\"processId\":\"%s\",\"completed\":%d}", PROCESS_ID, totalCompleted);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes());
            }
            if (conn.getResponseCode() == 200) {
                var resp = new String(conn.getInputStream().readAllBytes());
                if (resp.contains("\"stop\": true") || resp.contains("\"stop\":true")) {
                    aggregatorStop = true;
                }
            }
            conn.disconnect();
        } catch (Exception ignored) {
            // Aggregator unreachable — continue working
        }
    }

    // Hard cap on execution threads: avoids spawning 1600 OS threads at WPP=50 on a 2-vCPU VM.
    // 100× available processors is generous for I/O-bound handlers while preventing thread explosion.
    static final int DESIRED_THREADS = ACTIVATE_BATCH * NUM_WORKERS;
    static final int MAX_EXECUTION_THREADS = Math.min(DESIRED_THREADS,
            Runtime.getRuntime().availableProcessors() * 100);

    static final ObjectMapper mapper = new ObjectMapper();

    // ─── Main ────────────────────────────────────────────────

    public static void main(String[] args) {
        // Producer mode: deploy + pre-create, then exit
        if (args.length > 0 && "--produce".equals(args[0])) {
            try {
                runProducer();
            } catch (Exception e) {
                System.err.printf("[java-producer] Fatal: %s%n", e.getMessage());
                e.printStackTrace(System.err);
                System.exit(1);
            }
            return;
        }

        try {
            System.out.printf("[java-worker] id=%s mode=%s handler=%s workers=%d%n",
                    PROCESS_ID, SDK_MODE, HANDLER_TYPE, NUM_WORKERS);
            System.out.printf("[java-worker] target=%d/worker broker=%s%n",
                    TARGET_PER_WORKER, BROKER_REST_URL);
            System.out.printf("[java-worker] executionThreads=%d (desired=%d, cap=%d×%d)%n",
                    MAX_EXECUTION_THREADS, DESIRED_THREADS,
                    Runtime.getRuntime().availableProcessors(), 100);

            // Signal ready (barrier protocol)
            writeReady();
            waitForGo();

            System.out.println("[java-worker] GO received, starting benchmark...");

            // Start memory sampling (RSS via /proc/self/statm on Linux)
            var memSamples = new ArrayList<Long>();
            var memSamplerRunning = new AtomicBoolean(true);
            var memSampler = new Thread(() -> {
                memSamples.add(readRssBytes());
                while (memSamplerRunning.get()) {
                    try { Thread.sleep(5000); } catch (InterruptedException e) { break; }
                    if (memSamplerRunning.get()) memSamples.add(readRssBytes());
                }
                memSamples.add(readRssBytes());
            }, "mem-sampler");
            memSampler.setDaemon(true);
            memSampler.start();

            int[] workerCompleted;
            int[] workerErrors;
            double wallClockS;
            String stopReason;

            Map<String, Integer> errorTypeCounts;
            if ("grpc-streaming".equals(SDK_MODE)) {
                var result = runGrpcStreaming();
                workerCompleted = result.completed;
                workerErrors = result.errors;
                wallClockS = result.wallClockS;
                errorTypeCounts = result.errorTypes;
                stopReason = result.stopReason;
            } else if ("grpc-polling".equals(SDK_MODE)) {
                var result = runGrpcPolling();
                workerCompleted = result.completed;
                workerErrors = result.errors;
                wallClockS = result.wallClockS;
                errorTypeCounts = result.errorTypes;
                stopReason = result.stopReason;
            } else {
                var result = runRest();
                workerCompleted = result.completed;
                workerErrors = result.errors;
                wallClockS = result.wallClockS;
                errorTypeCounts = result.errorTypes;
                stopReason = result.stopReason;
            }

            int totalCompleted = Arrays.stream(workerCompleted).sum();
            int totalErrors = Arrays.stream(workerErrors).sum();
            double throughput = wallClockS > 0 ? totalCompleted / wallClockS : 0;
            double[] perWorkerThroughputs = Arrays.stream(workerCompleted)
                    .mapToDouble(c -> wallClockS > 0 ? c / wallClockS : 0).toArray();

            // Stop memory sampler and compute stats
            memSamplerRunning.set(false);
            memSampler.interrupt();
            memSampler.join(1000);
            double peakRssMb = 0, sumRssMb = 0;
            for (var s : memSamples) {
                double mb = s / (1024.0 * 1024.0);
                if (mb > peakRssMb) peakRssMb = mb;
                sumRssMb += mb;
            }
            double avgRssMb = memSamples.isEmpty() ? 0 : sumRssMb / memSamples.size();

            var output = mapper.createObjectNode();
            output.put("processId", PROCESS_ID);
            output.put("sdkMode", SDK_MODE);
            output.put("handlerType", HANDLER_TYPE);
            output.put("workersInProcess", NUM_WORKERS);
            output.put("totalCompleted", totalCompleted);
            output.put("totalErrors", totalErrors);
            output.put("wallClockS", wallClockS);
            output.put("throughput", throughput);
            output.put("stopReason", stopReason);
            output.set("perWorkerCompleted", intArrayToJson(workerCompleted));
            output.set("perWorkerErrors", intArrayToJson(workerErrors));
            output.set("perWorkerThroughputs", doubleArrayToJson(perWorkerThroughputs));
            output.set("errorTypes", mapper.valueToTree(errorTypeCounts));
            var memNode = mapper.createObjectNode();
            memNode.put("peakRssMb", Math.round(peakRssMb * 10.0) / 10.0);
            memNode.put("avgRssMb", Math.round(avgRssMb * 10.0) / 10.0);
            memNode.put("samples", memSamples.size());
            output.set("memoryUsage", memNode);

            System.out.printf("[java-worker] Done: %d completed, %d errors, %.1f ops/s%n",
                    totalCompleted, totalErrors, throughput);

            Files.writeString(Path.of(RESULT_FILE), mapper.writerWithDefaultPrettyPrinter().writeValueAsString(output));
            System.out.printf("[java-worker] Result written to %s%n", RESULT_FILE);

        } catch (Exception e) {
            System.err.printf("[java-worker] Fatal error: %s%n", e.getMessage());
            e.printStackTrace(System.err);
            writeErrorResult(e.getMessage());
            System.exit(1);
        }
    }

    // ─── Memory helper ───────────────────────────────────────

    /** Read current process RSS from /proc/self/statm (Linux). Returns bytes, or 0 on failure. */
    static long readRssBytes() {
        try {
            String statm = Files.readString(Path.of("/proc/self/statm"));
            long rssPages = Long.parseLong(statm.trim().split("\\s+")[1]);
            return rssPages * 4096L;
        } catch (Exception e) {
            return 0L;
        }
    }

    // ─── REST mode ───────────────────────────────────────────

    record RestResult(int[] completed, int[] errors, double wallClockS, Map<String, Integer> errorTypes, String stopReason) {}

    static RestResult runRest() throws Exception {
        var client = CamundaClient.newClientBuilder()
                .restAddress(URI.create(BROKER_REST_URL))
                .preferRestOverGrpc(true)
                .numJobWorkerExecutionThreads(MAX_EXECUTION_THREADS)
                .build();
        try {
            return runWorker(client, false);
        } finally {
            client.close();
        }
    }

    static String errorKey(Throwable error) {
        Throwable cause = error;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        String name = cause.getClass().getSimpleName();
        String msg = cause.getMessage();
        if (msg != null && msg.length() > 120) msg = msg.substring(0, 120);
        return msg != null ? name + ": " + msg : name;
    }

    // ─── gRPC streaming mode ─────────────────────────────────

    static RestResult runGrpcStreaming() throws Exception {
        String grpcUri = BROKER_GRPC_URL.startsWith("http") ? BROKER_GRPC_URL : "http://" + BROKER_GRPC_URL;
        var client = CamundaClient.newClientBuilder()
                .grpcAddress(URI.create(grpcUri))
                .preferRestOverGrpc(false)
                .numJobWorkerExecutionThreads(MAX_EXECUTION_THREADS)
                .build();
        try {
            return runWorker(client, true);
        } finally {
            client.close();
        }
    }

    // ─── gRPC polling mode ───────────────────────────────────

    static RestResult runGrpcPolling() throws Exception {
        String grpcUri = BROKER_GRPC_URL.startsWith("http") ? BROKER_GRPC_URL : "http://" + BROKER_GRPC_URL;
        var client = CamundaClient.newClientBuilder()
                .grpcAddress(URI.create(grpcUri))
                .preferRestOverGrpc(false)
                .numJobWorkerExecutionThreads(MAX_EXECUTION_THREADS)
                .build();
        try {
            return runWorker(client, false);
        } finally {
            client.close();
        }
    }

    // ─── Common worker logic ─────────────────────────────────

    static RestResult runWorker(CamundaClient client, boolean streamEnabled) throws Exception {
        int totalTarget = NUM_WORKERS * TARGET_PER_WORKER;
        var workerCompleted = new AtomicIntegerArray(NUM_WORKERS);
        var workerErrors = new AtomicIntegerArray(NUM_WORKERS);
        var errorTypes = new ConcurrentHashMap<String, AtomicInteger>();
        var done = new AtomicBoolean(false);
        // Track handler invocations for diagnostics
        var handlerInvocations = new AtomicInteger(0);

        long t0 = System.nanoTime();
        long deadline = t0 + (long) SCENARIO_TIMEOUT_S * 1_000_000_000L;

        var worker = client.newWorker()
                .jobType("test-job")
                .handler((jobClient, job) -> {
                    handlerInvocations.incrementAndGet();

                    if ("cpu".equals(HANDLER_TYPE) && HANDLER_LATENCY_MS > 0) {
                        cpuWork(HANDLER_LATENCY_MS);
                    } else if ("http".equals(HANDLER_TYPE) && HANDLER_LATENCY_MS > 0) {
                        Thread.sleep(HANDLER_LATENCY_MS);
                    }

                    // Complete the job asynchronously — never block the handler thread.
                    // Blocking with .join() causes deadlock when many handlers pile up
                    // (carrier-thread pinning in the SDK's internal HTTP client).
                    jobClient.newCompleteCommand(job).variables("{\"done\":true}").send()
                        .whenComplete((result, error) -> {
                            if (error == null) {
                                int minIdx = minIndex(workerCompleted);
                                workerCompleted.incrementAndGet(minIdx);
                                int total = sumArray(workerCompleted);
                                if (total >= totalTarget) done.set(true);
                            } else {
                                int minIdx = minIndex(workerErrors);
                                workerErrors.incrementAndGet(minIdx);
                                errorTypes.computeIfAbsent(errorKey(error), k -> new AtomicInteger()).incrementAndGet();
                            }
                        });
                })
                .maxJobsActive(ACTIVATE_BATCH * NUM_WORKERS)
                .streamEnabled(streamEnabled)
                .timeout(Duration.ofSeconds(30))
                .pollInterval(Duration.ofMillis(100))
                .open();

        while (!done.get() && !aggregatorStop && System.nanoTime() < deadline) {
            checkAggregatorStop(t0, sumArray(workerCompleted));
            Thread.sleep(50);
        }

        // Determine stop reason
        int totalFinal = sumArray(workerCompleted);
        String stopReason;
        if (totalFinal >= totalTarget) stopReason = "target";
        else if (aggregatorStop) stopReason = "pool-exhaustion";
        else stopReason = "timeout";

        // Close with a hard timeout — worker.close() can hang if handlers are stuck
        System.out.printf("[java-worker] Main loop ended: invocations=%d completed=%d errors=%d%n",
                handlerInvocations.get(), sumArray(workerCompleted), sumArray(workerErrors));
        var closeThread = new Thread(() -> {
            try { worker.close(); } catch (Exception ignored) {}
        }, "worker-close");
        closeThread.start();
        closeThread.join(30_000); // Wait at most 30s for graceful close
        if (closeThread.isAlive()) {
            System.out.println("[java-worker] worker.close() timed out after 30s — proceeding with results");
            closeThread.interrupt();
        }

        double wallClockS = (System.nanoTime() - t0) / 1e9;
        int[] completed = new int[NUM_WORKERS];
        int[] errors = new int[NUM_WORKERS];
        for (int i = 0; i < NUM_WORKERS; i++) {
            completed[i] = workerCompleted.get(i);
            errors[i] = workerErrors.get(i);
        }
        var errorTypeCounts = new LinkedHashMap<String, Integer>();
        errorTypes.entrySet().stream()
                .sorted((a, b) -> b.getValue().get() - a.getValue().get())
                .forEach(e -> errorTypeCounts.put(e.getKey(), e.getValue().get()));
        return new RestResult(completed, errors, wallClockS, errorTypeCounts, stopReason);
    }

    // ─── CPU work simulation ─────────────────────────────────

    static void cpuWork(int durationMs) {
        if (durationMs <= 0) return;
        long end = System.nanoTime() + (long) durationMs * 1_000_000L;
        double x = 0;
        while (System.nanoTime() < end) {
            x += Math.sin(x + 1);
        }
    }

    // ─── Barrier protocol ────────────────────────────────────

    static void writeReady() {
        if (READY_FILE.isEmpty()) return;
        try {
            var p = Path.of(READY_FILE);
            if (p.getParent() != null) Files.createDirectories(p.getParent());
            Files.writeString(p, "1");
        } catch (IOException e) {
            throw new RuntimeException("Failed to write ready file", e);
        }
    }

    static void waitForGo() throws InterruptedException {
        if (GO_FILE.isEmpty()) return;
        while (!Files.exists(Path.of(GO_FILE))) {
            Thread.sleep(10);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────

    static String env(String name, String defaultValue) {
        var v = System.getenv(name);
        return v != null ? v : defaultValue;
    }

    static int envInt(String name, int defaultValue) {
        var v = System.getenv(name);
        if (v == null) return defaultValue;
        try { return Integer.parseInt(v); } catch (NumberFormatException e) { return defaultValue; }
    }

    static int minIndex(AtomicIntegerArray arr) {
        int minIdx = 0;
        for (int i = 1; i < arr.length(); i++) {
            if (arr.get(i) < arr.get(minIdx)) minIdx = i;
        }
        return minIdx;
    }

    static int sumArray(AtomicIntegerArray arr) {
        int sum = 0;
        for (int i = 0; i < arr.length(); i++) sum += arr.get(i);
        return sum;
    }

    static JsonNode intArrayToJson(int[] arr) {
        var node = mapper.createArrayNode();
        for (int v : arr) node.add(v);
        return node;
    }

    static JsonNode doubleArrayToJson(double[] arr) {
        var node = mapper.createArrayNode();
        for (double v : arr) node.add(v);
        return node;
    }

    // ─── Producer mode ─────────────────────────────────────

    static void runProducer() throws Exception {
        var bpmnPath = env("BPMN_PATH", "");
        var precreateCount = envInt("PRECREATE_COUNT", 0);
        var payloadSizeKb = envInt("PAYLOAD_SIZE_KB", 10);
        var concurrency = 200;
        var continuous = "1".equals(env("CONTINUOUS", "0"));
        var readyFile = env("READY_FILE", "");
        var goFile = env("GO_FILE", "");
        var stopFile = env("STOP_FILE", "");
        var statsFile = env("PRODUCER_STATS_FILE", "");
        var precreateStatsFile = env("PRECREATE_STATS_FILE", "");

        if (bpmnPath.isEmpty()) {
            throw new IllegalStateException("BPMN_PATH not set");
        }

        System.out.printf("[java-producer] broker=%s bpmn=%s precreate=%d continuous=%s%n",
                BROKER_REST_URL, bpmnPath, precreateCount, continuous);

        var client = CamundaClient.newClientBuilder()
                .restAddress(URI.create(BROKER_REST_URL))
                .preferRestOverGrpc(true)
                .build();

        try {
            // Deploy
            System.out.println("[java-producer] Deploying process...");
            var deployResult = client.newDeployResourceCommand()
                    .addResourceFile(bpmnPath)
                    .send()
                    .join();
            var processDefKey = deployResult.getProcesses().get(0).getProcessDefinitionKey();
            System.out.printf("[java-producer] Deployed: %d%n", processDefKey);

            // Wait for deployment propagation
            Thread.sleep(10_000);

            // Build payload
            var rng = new Random();
            var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            var sb = new StringBuilder(payloadSizeKb * 1024);
            for (int i = 0; i < payloadSizeKb * 1024; i++) sb.append(chars.charAt(rng.nextInt(chars.length())));
            var payload = sb.toString();
            var variables = String.format("{\"data\":\"%s\"}", payload);

            // Phase 1: pre-create buffer
            if (precreateCount > 0) {
                var sem = new Semaphore(concurrency);
                var created = new AtomicInteger(0);
                var errors = new AtomicInteger(0);
                var executor = Executors.newFixedThreadPool(concurrency);
                long startMs = System.currentTimeMillis();
                long lastLogMs = startMs;

                System.out.printf("[java-producer] pre-create: creating %d instances...%n", precreateCount);

                var futures = new ArrayList<Future<?>>();
                for (int i = 0; i < precreateCount; i++) {
                    sem.acquire();
                    futures.add(executor.submit(() -> {
                        try {
                            client.newCreateInstanceCommand()
                                    .processDefinitionKey(processDefKey)
                                    .variables(variables)
                                    .send()
                                    .join();
                            created.incrementAndGet();
                        } catch (Exception ex) {
                            errors.incrementAndGet();
                        } finally {
                            sem.release();
                        }
                    }));

                    long now = System.currentTimeMillis();
                    if (now - lastLogMs > 10_000) {
                        int done = created.get() + errors.get();
                        double elapsedS = (now - startMs) / 1000.0;
                        double rate = elapsedS > 0 ? created.get() / elapsedS : 0;
                        System.out.printf("[java-producer] pre-create: %d/%d (%d ok, %d err) %.0fs, ~%.0f/s%n",
                                done, precreateCount, created.get(), errors.get(), elapsedS, rate);
                        lastLogMs = now;
                    }
                }

                for (var f : futures) f.get();
                executor.shutdown();

                double totalS = (System.currentTimeMillis() - startMs) / 1000.0;
                System.out.printf("[java-producer] pre-create: done %d created, %d errors in %.1fs%n",
                        created.get(), errors.get(), totalS);

                if (!precreateStatsFile.isEmpty()) {
                    var pcJson = String.format("{\"created\":%d,\"errors\":%d,\"durationS\":%.1f}",
                            created.get(), errors.get(), totalS);
                    Files.writeString(Path.of(precreateStatsFile), pcJson);
                    System.out.printf("[java-producer] Pre-create stats written to %s%n", precreateStatsFile);
                }
            }

            // Signal ready
            if (!readyFile.isEmpty()) {
                Files.writeString(Path.of(readyFile), "1");
                System.out.printf("[java-producer] Ready signal written to %s%n", readyFile);
            }

            if (!continuous) {
                System.out.println("[java-producer] Done (no continuous mode).");
                return;
            }

            // Wait for GO
            if (!goFile.isEmpty()) {
                System.out.printf("[java-producer] Waiting for GO file: %s%n", goFile);
                while (!Files.exists(Path.of(goFile))) {
                    Thread.sleep(100);
                }
                System.out.println("[java-producer] GO received, starting continuous production...");
            }

            // Phase 2: continuous production
            var sem2 = new Semaphore(concurrency);
            var contCreated = new AtomicInteger(0);
            var contErrors = new AtomicInteger(0);
            var executor2 = Executors.newFixedThreadPool(concurrency);
            long contStart = System.currentTimeMillis();
            long contLastLog = contStart;

            System.out.printf("[java-producer] continuous: starting (concurrency=%d)...%n", concurrency);

            while (stopFile.isEmpty() || !Files.exists(Path.of(stopFile))) {
                sem2.acquire();
                executor2.submit(() -> {
                    try {
                        client.newCreateInstanceCommand()
                                .processDefinitionKey(processDefKey)
                                .variables(variables)
                                .send()
                                .join();
                        contCreated.incrementAndGet();
                    } catch (Exception ex) {
                        contErrors.incrementAndGet();
                    } finally {
                        sem2.release();
                    }
                });

                long now = System.currentTimeMillis();
                if (now - contLastLog > 10_000) {
                    double elapsedS = (now - contStart) / 1000.0;
                    double rate = elapsedS > 0 ? contCreated.get() / elapsedS : 0;
                    System.out.printf("[java-producer] continuous: %d ok, %d err, %.0fs, ~%.0f/s%n",
                            contCreated.get(), contErrors.get(), elapsedS, rate);
                    contLastLog = now;
                }
            }

            // Drain remaining tasks
            executor2.shutdown();
            executor2.awaitTermination(30, TimeUnit.SECONDS);

            double contDuration = (System.currentTimeMillis() - contStart) / 1000.0;
            double contRate = contDuration > 0 ? contCreated.get() / contDuration : 0;
            System.out.printf("[java-producer] continuous: stopped. %d created, %d errors in %.1fs (~%.0f/s)%n",
                    contCreated.get(), contErrors.get(), contDuration, contRate);

            // Write stats
            if (!statsFile.isEmpty()) {
                var statsJson = String.format(
                        "{\"created\":%d,\"errors\":%d,\"durationS\":%.1f,\"rate\":%.1f}",
                        contCreated.get(), contErrors.get(), contDuration, contRate);
                Files.writeString(Path.of(statsFile), statsJson);
                System.out.printf("[java-producer] continuous: stats written to %s%n", statsFile);
            }
        } finally {
            client.close();
        }
    }

    static void writeErrorResult(String error) {
        try {
            var output = mapper.createObjectNode();
            output.put("processId", PROCESS_ID);
            output.put("sdkMode", SDK_MODE);
            output.put("handlerType", HANDLER_TYPE);
            output.put("workersInProcess", NUM_WORKERS);
            output.put("totalCompleted", 0);
            output.put("totalErrors", 0);
            output.put("wallClockS", 0);
            output.put("throughput", 0);
            output.set("perWorkerCompleted", mapper.createArrayNode());
            output.set("perWorkerErrors", mapper.createArrayNode());
            output.set("perWorkerThroughputs", mapper.createArrayNode());
            output.put("error", error);
            Files.writeString(Path.of(RESULT_FILE),
                    mapper.writerWithDefaultPrettyPrinter().writeValueAsString(output));
        } catch (Exception ignored) {}
    }
}
