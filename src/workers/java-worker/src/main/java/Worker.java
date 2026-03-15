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
    static final int HANDLER_LATENCY_MS = envInt("HANDLER_LATENCY_MS", 200);
    static final int NUM_WORKERS = envInt("NUM_WORKERS", 1);
    static final int TARGET_PER_WORKER = envInt("TARGET_PER_WORKER", 10000);
    static final int ACTIVATE_BATCH = envInt("ACTIVATE_BATCH", 32);
    static final int SCENARIO_TIMEOUT_S = envInt("SCENARIO_TIMEOUT_S", 300);
    static final String BROKER_REST_URL = env("BROKER_REST_URL", "http://localhost:8080").replaceAll("/+$", "");
    static final String BROKER_GRPC_URL = env("BROKER_GRPC_URL", "localhost:26500");
    static final String RESULT_FILE = env("RESULT_FILE", "./result.json");
    static final String READY_FILE = env("READY_FILE", "");
    static final String GO_FILE = env("GO_FILE", "");

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

            // Signal ready (barrier protocol)
            writeReady();
            waitForGo();

            System.out.println("[java-worker] GO received, starting benchmark...");

            int[] workerCompleted;
            int[] workerErrors;
            double wallClockS;

            if ("grpc-streaming".equals(SDK_MODE)) {
                var result = runGrpcStreaming();
                workerCompleted = result.completed;
                workerErrors = result.errors;
                wallClockS = result.wallClockS;
            } else if ("grpc-polling".equals(SDK_MODE)) {
                var result = runGrpcPolling();
                workerCompleted = result.completed;
                workerErrors = result.errors;
                wallClockS = result.wallClockS;
            } else {
                var result = runRest();
                workerCompleted = result.completed;
                workerErrors = result.errors;
                wallClockS = result.wallClockS;
            }

            int totalCompleted = Arrays.stream(workerCompleted).sum();
            int totalErrors = Arrays.stream(workerErrors).sum();
            double throughput = wallClockS > 0 ? totalCompleted / wallClockS : 0;
            double[] perWorkerThroughputs = Arrays.stream(workerCompleted)
                    .mapToDouble(c -> wallClockS > 0 ? c / wallClockS : 0).toArray();

            var output = mapper.createObjectNode();
            output.put("processId", PROCESS_ID);
            output.put("sdkMode", SDK_MODE);
            output.put("handlerType", HANDLER_TYPE);
            output.put("workersInProcess", NUM_WORKERS);
            output.put("totalCompleted", totalCompleted);
            output.put("totalErrors", totalErrors);
            output.put("wallClockS", wallClockS);
            output.put("throughput", throughput);
            output.set("perWorkerCompleted", intArrayToJson(workerCompleted));
            output.set("perWorkerErrors", intArrayToJson(workerErrors));
            output.set("perWorkerThroughputs", doubleArrayToJson(perWorkerThroughputs));

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

    // ─── REST mode ───────────────────────────────────────────

    record RestResult(int[] completed, int[] errors, double wallClockS) {}

    static RestResult runRest() throws Exception {
        var client = CamundaClient.newClientBuilder()
                .restAddress(URI.create(BROKER_REST_URL))
                .preferRestOverGrpc(true)
                .numJobWorkerExecutionThreads(NUM_WORKERS)
                .build();
        try {
            return runWorker(client, false);
        } finally {
            client.close();
        }
    }

    // ─── gRPC streaming mode ─────────────────────────────────

    static RestResult runGrpcStreaming() throws Exception {
        String grpcUri = BROKER_GRPC_URL.startsWith("http") ? BROKER_GRPC_URL : "http://" + BROKER_GRPC_URL;
        var client = CamundaClient.newClientBuilder()
                .grpcAddress(URI.create(grpcUri))
                .preferRestOverGrpc(false)
                .numJobWorkerExecutionThreads(NUM_WORKERS)
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
                .numJobWorkerExecutionThreads(NUM_WORKERS)
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
                            }
                        });
                })
                .maxJobsActive(ACTIVATE_BATCH * NUM_WORKERS)
                .streamEnabled(streamEnabled)
                .timeout(Duration.ofSeconds(30))
                .pollInterval(Duration.ofMillis(100))
                .open();

        while (!done.get() && System.nanoTime() < deadline) {
            Thread.sleep(50);
        }

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
        return new RestResult(completed, errors, wallClockS);
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
        var concurrency = 50;

        if (bpmnPath.isEmpty()) {
            throw new IllegalStateException("BPMN_PATH not set");
        }

        System.out.printf("[java-producer] broker=%s bpmn=%s precreate=%d%n",
                BROKER_REST_URL, bpmnPath, precreateCount);

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

            if (precreateCount <= 0) {
                System.out.println("[java-producer] No pre-creation requested, done.");
                return;
            }

            // Build payload
            var rng = new Random();
            var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            var sb = new StringBuilder(payloadSizeKb * 1024);
            for (int i = 0; i < payloadSizeKb * 1024; i++) sb.append(chars.charAt(rng.nextInt(chars.length())));
            var payload = sb.toString();
            var variables = String.format("{\"data\":\"%s\"}", payload);

            // Pre-create with concurrency control
            var sem = new Semaphore(concurrency);
            var created = new java.util.concurrent.atomic.AtomicInteger(0);
            var errors = new java.util.concurrent.atomic.AtomicInteger(0);
            var executor = Executors.newFixedThreadPool(concurrency);
            long startMs = System.currentTimeMillis();
            long lastLogMs = startMs;

            System.out.printf("[java-producer] Creating %d process instances...%n", precreateCount);

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
                    System.out.printf("[java-producer] %d/%d (%d ok, %d err) %.0fs, ~%.0f/s%n",
                            done, precreateCount, created.get(), errors.get(), elapsedS, rate);
                    lastLogMs = now;
                }
            }

            for (var f : futures) f.get();
            executor.shutdown();

            double totalS = (System.currentTimeMillis() - startMs) / 1000.0;
            System.out.printf("[java-producer] Done: %d created, %d errors in %.1fs%n",
                    created.get(), errors.get(), totalS);
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
