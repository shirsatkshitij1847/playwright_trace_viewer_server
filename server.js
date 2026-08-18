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

        server.listen(startPort, "127.0.0.1");

        server.on("listening", () => {

            const port = server.address().port;

            server.close(() => {
                resolve(port);
            });

        });

        server.on("error", (err) => {

            if (err.code === "EADDRINUSE") {

                // Try next port
                resolve(
                    getAvailablePort(startPort + 1)
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

app.get("/trace/:evidenceId", async (req, res) => {

    let tracePath = null;
    let traceProcess = null;
    let sessionId = null;

    try {

        const evidenceId = req.params.evidenceId;

        console.log("");
        console.log("====================================");
        console.log("TRACE REQUEST");
        console.log("====================================");

        console.log(
            "Evidence ID:",
            evidenceId
        );


        // -----------------------------------------
        // 1. Download trace from S3
        // -----------------------------------------

        tracePath =
            await downloadTrace(evidenceId);

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


        traceProcess = exec(command);


        // -----------------------------------------
        // 5. Store session
        // -----------------------------------------

        viewers.set(sessionId, {

            port: viewerPort,

            process: traceProcess,

            tracePath: tracePath,

            evidenceId: evidenceId

        });


        console.log("");
        console.log("VIEWER CREATED");
        console.log(
            `${sessionId} -> ${viewerPort}`
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


            // Delete downloaded ZIP
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
            viewers.delete(sessionId);

            console.log(
                "Session removed:",
                sessionId
            );


        }, TRACE_RETENTION_TIME);


        // -----------------------------------------
        // 7. Return public viewer URL
        // -----------------------------------------

        res.json({

            message:
                "Trace launched successfully",

            sessionId:

                sessionId,

            viewer:

                `http://localhost:3000/viewer/${sessionId}`,

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


        // Cleanup ZIP
        if (
            tracePath &&
            fs.existsSync(tracePath)
        ) {

            fs.unlink(
                tracePath,
                () => {}
            );

        }


        // Cleanup Playwright
        if (traceProcess) {

            traceProcess.kill();

        }


        // Cleanup session
        if (sessionId) {

            viewers.delete(sessionId);

        }


        res.status(500).json({

            error:
                err.message

        });

    }

});


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
// START SERVER
// =================================================

app.listen(PORT, () => {

    console.log("");
    console.log(
        "===================================="
    );

    console.log(
        `Server running at http://localhost:${PORT}`
    );

    console.log(
        "===================================="
    );

});