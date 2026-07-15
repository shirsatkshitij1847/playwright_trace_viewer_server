const express = require("express");
const downloadTrace = require("./s3");
const { exec } = require("child_process");

const app = express();

const PORT = 3000;

app.get("/trace/:evidenceId", async (req, res) => {

  try {

    const evidenceId = req.params.evidenceId;

    const tracePath = await downloadTrace(`${evidenceId}.zip`);

    exec(
      `npx playwright show-trace "${tracePath}" --host 0.0.0.0 --port 9323`
    );

    res.send({
      message: "Trace launched",
      viewer: "http://localhost:9323"
    });

  } catch (err) {

    console.error(err);

    res.status(500).send(err.message);

  }

});

app.listen(PORT, () => {

  console.log(`Server running on ${PORT}`);

});