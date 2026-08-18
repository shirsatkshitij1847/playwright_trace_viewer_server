const express = require("express");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createProxyMiddleware } = require("http-proxy-middleware");

const downloadTrace = require("./s3");

const app = express();


// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(process.env.PORT || 3000);

// Maximum simultaneous trace viewers
const MAX_VIEWERS = 20;

// Fixed Playwright ports
const PLAYWRIGHT_START_PORT = 9323;

const PLAYWRIGHT_PORTS = Array.from(
    { length: MAX_VIEWERS },
    (_, index) => PLAYWRIGHT_START_PORT + index
);

// Trace lifetime
const TRACE_RETENTION_TIME =
    10 * 60 * 1000;

// Directory for downloaded traces
const TRACE_DIRECTORY =
    path.join(__dirname, "traces");


// ============================================================
// CREATE TRACE DIRECTORY
// ============================================================

if (!fs.existsSync(TRACE_DIRECTORY)) {
    fs.mkdirSync(
        TRACE_DIRECTORY,
        {
            recursive: true
        }
    );
}


// ============================================================
// ACTIVE VIEWERS
// ============================================================
//
// sessionId -> {
//     port,
//     process,
//     tracePath,
//     evidenceId,
//     testExecutionId,
//     vuid,
//     createdAt,
//     cleanupTimer
// }
//
// ============================================================

const viewers = new Map();


// ============================================================
// RESERVED PORTS
// ============================================================
//
// This prevents two requests from receiving the same port
// while Playwright is starting.
//
// ============================================================

const reservedPorts = new Set();


// ============================================================
// PLAYWRIGHT CLI
// ============================================================

function getPlaywrightCli() {

    try {

        const packageJson =
            require.resolve("playwright/package.json");

        const playwrightDirectory =
            path.dirname(packageJson);

        const cli =
            path.join(
                playwrightDirectory,
                "cli.js"
            );

        if (!fs.existsSync(cli)) {

            throw new Error(
                `Playwright CLI not found: ${cli}`
            );

        }

        return cli;

    } catch (error) {

        throw new Error(
            "Playwright is not installed. " +
            "Run: npm install playwright"
        );

    }

}


// ============================================================
// PORT CHECK
// ============================================================

function isPortAvailable(port) {

    return new Promise((resolve) => {

        const server =
            net.createServer();

        server.once(
            "error",
            () => {

                resolve(false);

            }
        );

        server.once(
            "listening",
            () => {

                server.close(
                    () => {

                        resolve(true);

                    }
                );

            }
        );

        server.listen(
            port,
            "127.0.0.1"
        );

    });

}


// ============================================================
// GET FREE FIXED PORT
// ============================================================

async function getFreeViewerPort() {

    for (
        const port of PLAYWRIGHT_PORTS
    ) {

        // Already reserved by our application
        if (reservedPorts.has(port)) {
            continue;
        }

        // Check actual OS port
        const available =
            await isPortAvailable(port);

        if (!available) {
            continue;
        }

        // Reserve immediately
        reservedPorts.add(port);

        return port;

    }

    return null;

}


// ============================================================
// RELEASE PORT
// ============================================================

function releasePort(port) {

    reservedPorts.delete(port);

}


// ============================================================
// VALIDATE EXECUTION ID
// ============================================================

function validateTestExecutionId(value) {

    if (!value) {

        return {
            valid: false,
            error: "testExecutionId is required"
        };

    }

    if (
        typeof value !== "string" ||
        value.length > 200
    ) {

        return {
            valid: false,
            error: "Invalid testExecutionId"
        };

    }

    // Prevent S3 path traversal
    if (
        value.includes("/") ||
        value.includes("\\") ||
        value.includes("..")
    ) {

        return {
            valid: false,
            error: "Invalid testExecutionId"
        };

    }

    return {
        valid: true
    };

}


// ============================================================
// VALIDATE TRACE FILE
// ============================================================

function validateTraceFile(filename) {

    if (!filename) {

        return {
            valid: false,
            error: "Trace filename is required"
        };

    }

    if (
        typeof filename !== "string" ||
        filename.length > 255
    ) {

        return {
            valid: false,
            error: "Invalid trace filename"
        };

    }

    // Must be a zip
    if (
        !filename.toLowerCase().endsWith(".zip")
    ) {

        return {
            valid: false,
            error: "Trace filename must end with .zip"
        };

    }

    // No path traversal
    if (
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("..")
    ) {

        return {
            valid: false,
            error: "Invalid trace filename"
        };

    }

    // Only safe filename characters
    if (
        !/^[a-zA-Z0-9._-]+\.zip$/i.test(
            filename
        )
    ) {

        return {
            valid: false,
            error: "Invalid trace filename"
        };

    }

    return {
        valid: true
    };

}


// ============================================================
// EXTRACT VUID
// ============================================================
//
// vu38dc589.zip
//
// becomes
//
// vu38dc589
//
// ============================================================

function getVuidFromFilename(filename) {

    return filename.replace(
        /\.zip$/i,
        ""
    );

}


// ============================================================
// WAIT FOR PORT
// ============================================================

function waitForPort(
    port,
    timeout = 15000
) {

    return new Promise(
        (resolve, reject) => {

            const start =
                Date.now();

            function check() {

                const socket =
                    new net.Socket();

                socket.setTimeout(1000);

                socket.once(
                    "connect",
                    () => {

                        socket.destroy();

                        resolve();

                    }
                );

                socket.once(
                    "error",
                    () => {

                        socket.destroy();

                        if (
                            Date.now() - start >=
                            timeout
                        ) {

                            reject(
                                new Error(
                                    `Port ${port} did not become ready`
                                )
                            );

                            return;

                        }

                        setTimeout(
                            check,
                            200
                        );

                    }
                );

                socket.once(
                    "timeout",
                    () => {

                        socket.destroy();

                        if (
                            Date.now() - start >=
                            timeout
                        ) {

                            reject(
                                new Error(
                                    `Port ${port} did not become ready`
                                )
                            );

                            return;

                        }

                        setTimeout(
                            check,
                            200
                        );

                    }
                );

                socket.connect(
                    port,
                    "127.0.0.1"
                );

            }

            check();

        }
    );

}


// ============================================================
// STOP VIEWER
// ============================================================

function stopViewer(
    sessionId
) {

    const viewer =
        viewers.get(sessionId);

    if (!viewer) {
        return;
    }

    console.log("");
    console.log(
        "===================================="
    );

    console.log(
        "CLEANING VIEWER"
    );

    console.log(
        "Session:",
        sessionId
    );

    console.log(
        "Port:",
        viewer.port
    );


    // --------------------------------------------------------
    // Stop Playwright
    // --------------------------------------------------------

    if (
        viewer.process &&
        !viewer.process.killed
    ) {

        try {

            viewer.process.kill();

        } catch (error) {

            console.error(
                "Failed to stop Playwright:",
                error.message
            );

        }

    }


    // --------------------------------------------------------
    // Delete trace
    // --------------------------------------------------------

    if (
        viewer.tracePath &&
        fs.existsSync(viewer.tracePath)
    ) {

        try {

            fs.unlinkSync(
                viewer.tracePath
            );

            console.log(
                "Trace deleted:",
                viewer.tracePath
            );

        } catch (error) {

            console.error(
                "Failed to delete trace:",
                error.message
            );

        }

    }


    // --------------------------------------------------------
    // Release port
    // --------------------------------------------------------

    releasePort(
        viewer.port
    );


    // --------------------------------------------------------
    // Remove session
    // --------------------------------------------------------

    viewers.delete(
        sessionId
    );


    console.log(
        "Viewer removed"
    );

    console.log(
        "Active viewers:",
        viewers.size
    );

}


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            status: "ok",

            service:
                "playwright-trace-viewer",

            uptime:
                process.uptime(),

            activeViewers:
                viewers.size,

            maxViewers:
                MAX_VIEWERS,

            availableSlots:
                MAX_VIEWERS - viewers.size,

            playwrightPorts:
                PLAYWRIGHT_PORTS

        });

    }
);


// ============================================================
// PORT INFORMATION
// ============================================================

app.get(
    "/port",
    (req, res) => {

        const ports = PLAYWRIGHT_PORTS.map(
            (port) => {

                let sessionId = null;

                for (
                    const [
                        id,
                        viewer
                    ] of viewers
                ) {

                    if (
                        viewer.port === port
                    ) {

                        sessionId = id;

                        break;

                    }

                }

                return {

                    port,

                    reserved:
                        reservedPorts.has(port),

                    active:
                        Boolean(sessionId),

                    sessionId

                };

            }
        );

        res.json({

            maxViewers:
                MAX_VIEWERS,

            activeViewers:
                viewers.size,

            availableSlots:
                MAX_VIEWERS - viewers.size,

            ports

        });

    }
);


// ============================================================
// CREATE TRACE VIEWER
// ============================================================
//
// Example:
//
// GET /trace/vu38dc589.zip?testExecutionId=testexecution1234
//
// ============================================================

app.get(
    "/trace/:filename",
    async (req, res) => {

        let tracePath = null;
        let traceProcess = null;
        let sessionId = null;
        let viewerPort = null;
        let cleanupTimer = null;

        try {

            console.log("");
            console.log(
                "===================================="
            );

            console.log(
                "TRACE REQUEST"
            );

            console.log(
                "===================================="
            );


            // ------------------------------------------------
            // Parameters
            // ------------------------------------------------

            const filename =
                req.params.filename;

            const testExecutionId =
                req.query.testExecutionId;


            console.log(
                "Filename:",
                filename
            );

            console.log(
                "Execution:",
                testExecutionId
            );


            // ------------------------------------------------
            // Validate filename
            // ------------------------------------------------

            const filenameValidation =
                validateTraceFile(
                    filename
                );

            if (
                !filenameValidation.valid
            ) {

                return res.status(400).json({

                    error:
                        filenameValidation.error

                });

            }


            // ------------------------------------------------
            // Validate execution ID
            // ------------------------------------------------

            const executionValidation =
                validateTestExecutionId(
                    testExecutionId
                );

            if (
                !executionValidation.valid
            ) {

                return res.status(400).json({

                    error:
                        executionValidation.error

                });

            }


            // ------------------------------------------------
            // VUID comes from filename
            // ------------------------------------------------

            const vuid =
                getVuidFromFilename(
                    filename
                );


            console.log(
                "VUID:",
                vuid
            );


            // ------------------------------------------------
            // Maximum viewer limit
            // ------------------------------------------------

            if (
                viewers.size >=
                MAX_VIEWERS
            ) {

                return res.status(429).json({

                    error:
                        "Maximum trace viewer limit reached",

                    maxViewers:
                        MAX_VIEWERS,

                    message:
                        "Please try again later"

                });

            }


            // ------------------------------------------------
            // Get fixed port
            // ------------------------------------------------

            viewerPort =
                await getFreeViewerPort();


            if (!viewerPort) {

                return res.status(503).json({

                    error:
                        "No trace viewer slots available",

                    maxViewers:
                        MAX_VIEWERS

                });

            }


            console.log(
                "Viewer port:",
                viewerPort
            );


            // ------------------------------------------------
            // Download S3 trace
            // ------------------------------------------------

            tracePath =
                await downloadTrace(
                    testExecutionId,
                    filename
                );


            if (
                !tracePath ||
                !fs.existsSync(tracePath)
            ) {

                throw new Error(
                    "Trace download failed"
                );

            }


            console.log(
                "Trace:",
                tracePath
            );


            // ------------------------------------------------
            // Session ID
            // ------------------------------------------------

            sessionId =
                crypto
                    .randomBytes(16)
                    .toString("hex");


            console.log(
                "Session:",
                sessionId
            );


            // ------------------------------------------------
            // Playwright CLI
            // ------------------------------------------------

            const playwrightCli =
                getPlaywrightCli();


            console.log(
                "Playwright CLI:",
                playwrightCli
            );


            // ------------------------------------------------
            // Start Playwright
            // ------------------------------------------------

            const args = [

                playwrightCli,

                "show-trace",

                tracePath,

                "--host",
                "127.0.0.1",

                "--port",
                String(viewerPort)

            ];


            console.log(
                "Starting Playwright..."
            );


            traceProcess =
                spawn(
                    process.execPath,
                    args,
                    {

                        stdio: [
                            "ignore",
                            "pipe",
                            "pipe"
                        ],

                        windowsHide:
                            true

                    }
                );


            // ------------------------------------------------
            // Playwright stdout
            // ------------------------------------------------

            traceProcess.stdout.on(
                "data",
                (data) => {

                    console.log(
                        `[Playwright ${viewerPort}] ${data.toString().trim()}`
                    );

                }
            );


            // ------------------------------------------------
            // Playwright stderr
            // ------------------------------------------------

            traceProcess.stderr.on(
                "data",
                (data) => {

                    console.error(
                        `[Playwright ${viewerPort}] ${data.toString().trim()}`
                    );

                }
            );


            // ------------------------------------------------
            // Spawn error
            // ------------------------------------------------

            traceProcess.on(
                "error",
                (error) => {

                    console.error(
                        "Playwright process error:",
                        error
                    );

                }
            );


            // ------------------------------------------------
            // Process exit
            // ------------------------------------------------

            traceProcess.on(
                "exit",
                (code, signal) => {

                    console.log(
                        `Playwright exited. Port=${viewerPort} Code=${code} Signal=${signal}`
                    );

                }
            );


            // ------------------------------------------------
            // Wait until Playwright is listening
            // ------------------------------------------------

            await waitForPort(
                viewerPort
            );


            console.log(
                `Playwright ready on ${viewerPort}`
            );


            // ------------------------------------------------
            // Store viewer
            // ------------------------------------------------

            viewers.set(
                sessionId,
                {

                    port:
                        viewerPort,

                    process:
                        traceProcess,

                    tracePath:
                        tracePath,

                    filename:
                        filename,

                    evidenceId:
                        filename,

                    testExecutionId:
                        testExecutionId,

                    vuid:
                        vuid,

                    createdAt:
                        Date.now(),

                    cleanupTimer:
                        null

                }
            );


            // ------------------------------------------------
            // Cleanup timer
            // ------------------------------------------------

            cleanupTimer =
                setTimeout(
                    () => {

                        stopViewer(
                            sessionId
                        );

                    },
                    TRACE_RETENTION_TIME
                );


            const viewer =
                viewers.get(
                    sessionId
                );

            viewer.cleanupTimer =
                cleanupTimer;


            // ------------------------------------------------
            // Return response
            // ------------------------------------------------

            const host =
                req.get("host");


            const protocol =
                req.protocol;


            res.status(200).json({

                success:
                    true,

                message:
                    "Trace viewer started",

                sessionId:
                    sessionId,

                viewer:
                    `${protocol}://${host}/viewer/${sessionId}/`,

                testExecutionId:
                    testExecutionId,

                filename:
                    filename,

                vuid:
                    vuid,

                port:
                    viewerPort,

                expiresIn:
                    "10 minutes",

                activeViewers:
                    viewers.size,

                maxViewers:
                    MAX_VIEWERS

            });


        } catch (error) {

            console.error("");
            console.error(
                "TRACE ERROR:",
                error
            );


            // ------------------------------------------------
            // Kill Playwright
            // ------------------------------------------------

            if (
                traceProcess &&
                !traceProcess.killed
            ) {

                try {

                    traceProcess.kill();

                } catch {}

            }


            // ------------------------------------------------
            // Release port
            // ------------------------------------------------

            if (viewerPort) {

                releasePort(
                    viewerPort
                );

            }


            // ------------------------------------------------
            // Delete trace
            // ------------------------------------------------

            if (
                tracePath &&
                fs.existsSync(tracePath)
            ) {

                try {

                    fs.unlinkSync(
                        tracePath
                    );

                } catch {}

            }


            // ------------------------------------------------
            // Remove session
            // ------------------------------------------------

            if (sessionId) {

                viewers.delete(
                    sessionId
                );

            }


            // ------------------------------------------------
            // Error response
            // ------------------------------------------------

            let statusCode = 500;

            let errorMessage =
                error.message ||
                "Internal server error";


            // S3 not found
            if (
                error.name ===
                "NoSuchKey"
            ) {

                statusCode = 404;

                errorMessage =
                    "Trace file not found in S3";

            }


            res.status(
                statusCode
            ).json({

                success:
                    false,

                error:
                    errorMessage,

                testExecutionId:
                    testExecutionId || null,

                filename:
                    req.params.filename || null

            });

        }

    }
);


// ============================================================
// SESSION INFO
// ============================================================

app.get(
    "/trace-session/:sessionId",
    (req, res) => {

        const sessionId =
            req.params.sessionId;

        const viewer =
            viewers.get(
                sessionId
            );


        if (!viewer) {

            return res.status(404).json({

                success:
                    false,

                error:
                    "Trace session not found or expired"

            });

        }


        const expiresAt =
            viewer.createdAt +
            TRACE_RETENTION_TIME;


        res.json({

            success:
                true,

            sessionId:
                sessionId,

            filename:
                viewer.filename,

            vuid:
                viewer.vuid,

            testExecutionId:
                viewer.testExecutionId,

            port:
                viewer.port,

            createdAt:
                new Date(
                    viewer.createdAt
                ).toISOString(),

            expiresAt:
                new Date(
                    expiresAt
                ).toISOString(),

            remainingSeconds:
                Math.max(
                    0,
                    Math.floor(
                        (
                            expiresAt -
                            Date.now()
                        ) / 1000
                    )
                )

        });

    }
);


// ============================================================
// VIEWER PROXY
// ============================================================
//
// /viewer/:sessionId/
//
// is proxied to:
//
// http://127.0.0.1:<fixed-port>/
//
// ============================================================

app.use(
    "/viewer/:sessionId",
    (req, res, next) => {

        const sessionId =
            req.params.sessionId;


        const viewer =
            viewers.get(
                sessionId
            );


        if (!viewer) {

            return res.status(404).send(
                "Trace viewer expired or not found"
            );

        }


        console.log(
            "VIEWER:",
            sessionId,
            "->",
            viewer.port
        );


        return createProxyMiddleware({

            target:
                `http://127.0.0.1:${viewer.port}`,

            changeOrigin:
                true,

            ws:
                true,

            pathRewrite:
                (path) => {

                    // Remove:
                    //
                    // /viewer/<sessionId>
                    //
                    // leaving:
                    //
                    // /

                    const prefix =
                        `/viewer/${sessionId}`;

                    if (
                        path.startsWith(prefix)
                    ) {

                        return (
                            path.substring(
                                prefix.length
                            ) || "/"
                        );

                    }

                    return path;

                },

            onError:
                (error, req, res) => {

                    console.error(
                        "Proxy error:",
                        error.message
                    );

                }

        })(req, res, next);

    }
);


// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({

            success:
                false,

            error:
                "Route not found",

            path:
                req.path

        });

    }
);


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled error:",
            error
        );


        if (
            res.headersSent
        ) {

            return next(error);

        }


        res.status(500).json({

            success:
                false,

            error:
                "Internal server error"

        });

    }
);


// ============================================================
// START SERVER
// ============================================================

const server =
    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log("");
            console.log(
                "================================"
            );

            console.log(
                "TRACE VIEWER SERVER"
            );

            console.log(
                "================================"
            );

            console.log(
                `Server: http://0.0.0.0:${PORT}`
            );

            console.log(
                `Max viewers: ${MAX_VIEWERS}`
            );

            console.log(
                `Viewer ports: ${PLAYWRIGHT_START_PORT}-${PLAYWRIGHT_START_PORT + MAX_VIEWERS - 1}`
            );

            console.log(
                "Playwright CLI:",
                getPlaywrightCli()
            );

            console.log(
                "================================"
            );

        }
    );


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(signal) {

    console.log("");
    console.log(
        `${signal} received. Shutting down...`
    );


    // Stop all viewers
    for (
        const sessionId
        of viewers.keys()
    ) {

        stopViewer(
            sessionId
        );

    }


    server.close(
        () => {

            console.log(
                "HTTP server closed"
            );

            process.exit(0);

        }
    );


    // Force shutdown after 10 seconds
    setTimeout(
        () => {

            process.exit(1);

        },
        10000
    );

}


process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);