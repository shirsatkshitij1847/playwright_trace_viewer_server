const express = require("express");
const downloadTrace = require("./s3");
const { exec } = require("child_process");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

const PORT = 3000;

// Keep trace alive for 10 minutes
const TRACE_RETENTION_TIME = 10 * 60 * 1000;


// ---------------------------------------------
// Active Playwright viewers
// ---------------------------------------------

const viewers = new Map();


// ---------------------------------------------
// Find available port
// ---------------------------------------------

function getAvailablePort(startPort = 9323) {

    return new Promise((resolve, reject) => {

        const server = net.createServer();

        server.listen(
            startPort,
            "127.0.0.1"
        );

        server.on("listening", () => {

            const port =
                server.address().port;

            server.close(() => {

                resolve(port);

            });

        });

        server.on("error", (err) => {

            if (err.code === "EADDRINUSE") {

                resolve(
                    getAvailablePort(
                        startPort + 1
                    )
                );

            } else {

                reject(err);

            }

        });

    });

}


// =================================================
// CREATE TRACE
// =================================================

app.get(
    "/trace/:evidenceId",
    async (req, res) => {

        let tracePath = null;
        let traceProcess = null;
        let sessionId = null;

        try {

            // -----------------------------------------
            // Parameters
            // -----------------------------------------

            const evidenceId =
                req.params.evidenceId;

            const {
                testExecutionId,
                vuid
            } = req.query;


            // -----------------------------------------
            // Validate parameters
            // -----------------------------------------

            if (!testExecutionId) {

                return res.status(400).json({

                    error:
                        "testExecutionId is required"

                });

            }


            if (!vuid) {

                return res.status(400).json({

                    error:
                        "vuid is required"

                });

            }


            console.log("");
            console.log("====================================");
            console.log("TRACE REQUEST");
            console.log("====================================");

            console.log(
                "Evidence ID:",
                evidenceId
            );

            console.log(
                "Test Execution ID:",
                testExecutionId
            );

            console.log(
                "VUID:",
                vuid
            );


            // -----------------------------------------
            // 1. Download trace from S3
            // -----------------------------------------

            tracePath =
                await downloadTrace(
                    testExecutionId,
                    evidenceId
                );

            console.log(
                "Trace downloaded:",
                tracePath
            );


            // -----------------------------------------
            // 2. Find available port
            // -----------------------------------------

            const viewerPort =
                await getAvailablePort(9323);

            console.log(
                "Playwright port:",
                viewerPort
            );


            // -----------------------------------------
            // 3. Create session ID
            // -----------------------------------------

            sessionId =
                crypto.randomBytes(16).toString("hex");

            console.log(
                "Session ID:",
                sessionId
            );


            // -----------------------------------------
            // 4. Start Playwright
            // -----------------------------------------

            const command =
                `npx playwright show-trace ` +
                `"${tracePath}" ` +
                `--host 127.0.0.1 ` +
                `--port ${viewerPort}`;

            console.log(
                "Starting:",
                command
            );


            traceProcess =
                exec(command);


            // -----------------------------------------
            // 5. Store session
            // -----------------------------------------

            viewers.set(
                sessionId,
                {

                    port:
                        viewerPort,

                    process:
                        traceProcess,

                    tracePath:
                        tracePath,

                    evidenceId:
                        evidenceId,

                    testExecutionId:
                        testExecutionId,

                    vuid:
                        vuid

                }
            );


            console.log("");
            console.log("VIEWER CREATED");

            console.log(
                `${sessionId} -> ${viewerPort}`
            );

            console.log(
                "Evidence ID:",
                evidenceId
            );

            console.log(
                "Test Execution ID:",
                testExecutionId
            );

            console.log(
                "VUID:",
                vuid
            );


            // -----------------------------------------
            // Playwright logs
            // -----------------------------------------

            traceProcess.stdout.on(
                "data",
                (data) => {

                    console.log(
                        `[Playwright ${viewerPort}] ${data}`
                    );

                }
            );


            traceProcess.stderr.on(
                "data",
                (data) => {

                    console.error(
                        `[Playwright ${viewerPort}] ${data}`
                    );

                }
            );


            // -----------------------------------------
            // Playwright process exit
            // -----------------------------------------

            traceProcess.on(
                "exit",
                (code, signal) => {

                    console.log(
                        `Playwright exited. ` +
                        `Port: ${viewerPort}, ` +
                        `Code: ${code}, ` +
                        `Signal: ${signal}`
                    );

                }
            );


            // -----------------------------------------
            // 6. Cleanup after 10 minutes
            // -----------------------------------------

            setTimeout(() => {

                console.log("");
                console.log(
                    "CLEANING TRACE:",
                    sessionId
                );


                // Stop Playwright

                if (traceProcess) {

                    traceProcess.kill();

                    console.log(
                        "Playwright stopped:",
                        viewerPort
                    );

                }


                // Delete downloaded trace

                if (
                    tracePath &&
                    fs.existsSync(tracePath)
                ) {

                    fs.unlink(
                        tracePath,
                        (err) => {

                            if (err) {

                                console.error(
                                    "Failed to delete trace:",
                                    err
                                );

                            } else {

                                console.log(
                                    "Trace deleted:",
                                    tracePath
                                );

                            }

                        }
                    );

                }


                // Remove session

                viewers.delete(
                    sessionId
                );

                console.log(
                    "Session removed:",
                    sessionId
                );


            }, TRACE_RETENTION_TIME);


            // -----------------------------------------
            // 7. Return viewer URL
            // -----------------------------------------

            res.json({

                message:
                    "Trace launched successfully",

                sessionId:
                    sessionId,

                viewer:
                    `http://localhost:${PORT}/viewer/${sessionId}`,

                evidenceId:
                    evidenceId,

                testExecutionId:
                    testExecutionId,

                vuid:
                    vuid,

                port:
                    viewerPort,

                expiresIn:
                    "10 minutes"

            });


        } catch (err) {

            console.error(
                "TRACE ERROR:",
                err
            );


            // -----------------------------------------
            // Cleanup trace
            // -----------------------------------------

            if (
                tracePath &&
                fs.existsSync(tracePath)
            ) {

                fs.unlink(
                    tracePath,
                    () => {}
                );

            }


            // -----------------------------------------
            // Cleanup Playwright
            // -----------------------------------------

            if (traceProcess) {

                traceProcess.kill();

            }


            // -----------------------------------------
            // Cleanup session
            // -----------------------------------------

            if (sessionId) {

                viewers.delete(
                    sessionId
                );

            }


            res.status(500).json({

                error:
                    err.message

            });

        }

    }
);


// =================================================
// DYNAMIC PROXY
// =================================================

app.use(
    "/viewer/:sessionId",
    (req, res, next) => {

        const sessionId =
            req.params.sessionId;


        console.log("");
        console.log(
            "VIEWER REQUEST:",
            sessionId
        );


        // -----------------------------------------
        // Find session
        // -----------------------------------------

        const viewer =
            viewers.get(sessionId);


        // -----------------------------------------
        // Session doesn't exist
        // -----------------------------------------

        if (!viewer) {

            return res.status(404).send(
                "Trace viewer expired or not found"
            );

        }


        console.log(
            "Proxy target:",
            `http://127.0.0.1:${viewer.port}`
        );


        console.log(
            "Evidence ID:",
            viewer.evidenceId
        );

        console.log(
            "Test Execution ID:",
            viewer.testExecutionId
        );

        console.log(
            "VUID:",
            viewer.vuid
        );


        // -----------------------------------------
        // Forward request to Playwright
        // -----------------------------------------

        return createProxyMiddleware({

            target:
                `http://127.0.0.1:${viewer.port}`,

            changeOrigin:
                true,

            ws:
                true,

            pathRewrite:
                (path) => {

                    return path.replace(
                        `/viewer/${sessionId}`,
                        ""
                    );

                }

        })(req, res, next);

    }
);


// =================================================
// OPTIONAL: SESSION INFO API
// =================================================

app.get(
    "/trace-session/:sessionId",
    (req, res) => {

        const sessionId =
            req.params.sessionId;

        const viewer =
            viewers.get(sessionId);


        if (!viewer) {

            return res.status(404).json({

                error:
                    "Trace session not found or expired"

            });

        }


        res.json({

            sessionId:
                sessionId,

            port:
                viewer.port,

            evidenceId:
                viewer.evidenceId,

            testExecutionId:
                viewer.testExecutionId,

            vuid:
                viewer.vuid

        });

    }
);


// =================================================
// START SERVER
// =================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log("");
        console.log("====================================");
        console.log(
            `Server running on http://0.0.0.0:${PORT}`
        );
        console.log("====================================");

    }
);
