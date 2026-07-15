const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
require("dotenv").config();


const client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});
async function downloadTrace(traceId) {

  const bucket = "playwright-execution-results";

  const key = `Playwrigth_Trace_Viewer/${traceId}`;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  });

  const response = await client.send(command);

  const traceFolder = path.join(__dirname, "traces");

  if (!fs.existsSync(traceFolder))
    fs.mkdirSync(traceFolder);

  const tracePath = path.join(traceFolder, "trace.zip");

  const writeStream = fs.createWriteStream(tracePath);

  await new Promise((resolve, reject) => {

    response.Body.pipe(writeStream);

    response.Body.on("error", reject);

    writeStream.on("finish", resolve);

  });

  return tracePath;

}

module.exports = downloadTrace;


(async ()=>{
    await downloadTrace("trace1.zip");
})()