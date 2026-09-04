const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const fs = require("fs");
const path = require("path");

require("dotenv").config();

const client = new S3Client({
    region: process.env.AWS_REGION,

    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,

        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

async function downloadTrace(testExecutionId, evidenceId) {
    // ---------------------------------------------
    // S3 configuration
    // ---------------------------------------------

    const bucket = "sas-migration-result-eveidence";

    const key = `${testExecutionId}/${evidenceId}`;

    console.log("");
    console.log("====================================");
    console.log("S3 TRACE DOWNLOAD");
    console.log("====================================");

    console.log("Bucket:", bucket);

    console.log("Key:", key);

    console.log(`s3://${bucket}/${key}`);

    // ---------------------------------------------
    // Get object
    // ---------------------------------------------

    const command = new GetObjectCommand({
        Bucket: bucket,

        Key: key,
    });

    const response = await client.send(command);

    // ---------------------------------------------
    // Create local traces folder
    // ---------------------------------------------

    const traceFolder = path.join(__dirname, "traces");

    if (!fs.existsSync(traceFolder)) {
        fs.mkdirSync(traceFolder, {
            recursive: true,
        });
    }

    // ---------------------------------------------
    // Unique local filename
    // ---------------------------------------------

    const uniqueName = `${Date.now()}-` + `${Math.random().toString(36).substring(2)}-` + `${evidenceId}`;

    const tracePath = path.join(traceFolder, uniqueName);

    console.log("Local trace path:", tracePath);

    // ---------------------------------------------
    // Write S3 stream to file
    // ---------------------------------------------

    const writeStream = fs.createWriteStream(tracePath);

    await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream);

        response.Body.on("error", (err) => {
            reject(err);
        });

        writeStream.on("error", (err) => {
            reject(err);
        });

        writeStream.on("finish", () => {
            resolve();
        });
    });

    console.log("Trace saved locally:", tracePath);

    return tracePath;
}

module.exports = downloadTrace;
