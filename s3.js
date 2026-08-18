const {
  S3Client,
  GetObjectCommand
} = require("@aws-sdk/client-s3");

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

  const bucket = "sas-migration-result-eveidence";

  const key = `testExecution-1786976044823/${traceId}`;


  console.log("Downloading from S3:");

  console.log( `s3://${bucket}/${key}`);


  const command =
    new GetObjectCommand({

      Bucket: bucket,
      Key: key

    });


  const response = await client.send(command);


  const traceFolder = path.join(__dirname, "traces");


  if (!fs.existsSync(traceFolder)) {

    fs.mkdirSync(traceFolder, {
      recursive: true
    });

  }


  // Unique local filename
  const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2)}-${traceId}`;


  const tracePath =
    path.join( traceFolder, uniqueName );


  const writeStream = fs.createWriteStream(tracePath);


  await new Promise((resolve, reject) => {

    response.Body.pipe(writeStream);

    response.Body.on(
      "error",
      reject
    );

    writeStream.on(
      "error",
      reject
    );

    writeStream.on(
      "finish",
      resolve
    );

  });


  console.log( "Trace saved locally:",  tracePath );

  return tracePath;

}


module.exports = downloadTrace;