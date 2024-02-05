const _ = require("lodash");
const WebSocket = require("ws");
const express = require("express");
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });
const path = require("path");
const fs = require("fs");
const Sentiment = require('sentiment');
var sentiment = new Sentiment();
const { Storage } = require('@google-cloud/storage');
const storage = new Storage();
const bucketName = 'transctipt';
const AWS = require('aws-sdk');
const sentimentBucket = 'sentiments_test';
const { DynamoDB } = require("@aws-sdk/client-dynamodb");
var callId="";
var dt=Date.now();
const bodyParser = require("body-parser");

AWS.config.update({ region: 'us-east-1' });

//Include Google Speech to Text
const speech = require("@google-cloud/speech");
const speechClient = new speech.SpeechClient();

//Configure Transcription Request
const transcriptionConfig = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "en-GB",
  },
  interimResults: false, // If you want interim results, set this to true
};

//creating this method to store the transcript
const uploadFileToGCS = async (filePath, destination) => {
  try {
    await storage.bucket(bucketName).upload(filePath, {
      destination: destination,
    });
    console.log(`${filePath} uploaded to ${bucketName}`);
  } catch (error) {
    console.error(`Error uploading ${filePath} to Google Cloud Storage:`, error);
  }
};

const uploadSentimentsFileToGCS = async (filePath, destination) => {
  try {
    await storage.bucket(sentimentBucket).upload(filePath, {
      destination: destination,
    });
    console.log(`${filePath} uploaded to ${sentimentBucket}`);
  } catch (error) {
    console.error(`Error uploading ${filePath} to Google Cloud Storage:`, error);
  }
};

let activeCalls = [];

wss.on("connection", function connection(ws) {

  console.log("New Connection Initiated");



  // Create writable streams for storing transcripts and sentiment analysis results
  const transcriptFilePath = `transcript_${callId+dt}.txt`;
  const transcriptFileStream = fs.createWriteStream(transcriptFilePath, { flags: "a" });

  const sentimentFilePath = `sentiment${callId+dt}.txt`;
  const sentimentFileStream = fs.createWriteStream(sentimentFilePath, { flags: "a" });

  let recognizeStream;

  ws.on("message", function incoming(message) {



    const msg = JSON.parse(message);



    switch (msg.event) {

      case "connected":

        console.log(`A new call has connected.`);

        break;

      case "start":

        console.log(`Starting Media Stream ${msg.streamSid}`);



        ws.streamSid = msg.streamSid;

        // Create Stream to the Google Speech to Text API
        recognizeStream = speechClient
          .streamingRecognize(transcriptionConfig)
          .on("error", console.error)
          .on("data", (data) => {
            wss.clients.forEach((client) => {
              if (
                client.readyState === WebSocket.OPEN &&
                client.subscribedStream === msg.streamSid
              ) {
                client.send(
                  JSON.stringify({
                    stream: msg.streamSid,
                    event: "interim-transcription",
                    text: data.results[0].alternatives[0].transcript,
                  })
                );
              }
            });
            // Append the transcript to the text file
            transcriptFileStream.write(data.results[0].alternatives[0].transcript + "\n");
            sentimentFileStream.write(JSON.stringify(sentiment.analyze(data.results[0].alternatives[0].transcript)) + "\n");


          });

        activeCalls.push({
          twilioStreamSid: msg.streamSid,
          fromNumber: msg.start.customParameters.number,
        });

        wss.clients.forEach((client) => {
          client.send(
            JSON.stringify({
              event: "updateCalls",
              activeCalls,
            })
          );
        });





        console.log(`There are ${activeCalls.length} active calls`);
        break;

      case "media":
        // Write Media Packets to the recognize stream
        recognizeStream.write(msg.media.payload);
        break;

      case "stop":
        console.log(`Call Has Ended`);
        console.log(ws.streamSid);
        const i = activeCalls.findIndex(
          (stream) => stream.streamSid === ws.streamSid
        );
        activeCalls.splice(i, 1);
        wss.clients.forEach((client) => {
          client.send(
            JSON.stringify({
              event: "updateCalls",
              activeCalls: activeCalls,
            })
          );
        });
        recognizeStream.destroy();
        break;

      case "subscribe":
        console.log("Client Subscribed");
        ws.subscribedStream = msg.streamSid;
        break;

      default:
        break;
    }
  });

  ws.on("close", function close() {

    uploadFileToGCS(transcriptFilePath, "transcripts/" + path.basename(transcriptFilePath))
      .then(() => {
        // Delete the local transcript file after successful upload
        fs.unlink(transcriptFilePath, (err) => {
          if (err) {
            console.error(`Error deleting local transcript file ${transcriptFilePath}:`, err);
          } else {
            console.log(`Local transcript file ${transcriptFilePath} deleted.`);
          }
        });
      })
      .catch(console.error);

    uploadSentimentsFileToGCS(sentimentFilePath, "Sentiment Result/" + path.basename(sentimentFilePath))
      .then(() => {

        // Read the sentiment file content
        const sentimentData = fs.readFileSync(sentimentFilePath, "utf-8").split("\n");

        const result = processRawData(sentimentData);

        console.log('Final Score:', result.score);
        console.log('Positive Words:', result.positiveWords);
        console.log('Negative Words:', result.negativeWords);

        const items = [
          {
            id: (callId+dt).toString(),
            positive_words: result.positiveWords.toString(),
            negative_words: result.negativeWords.toString(),
            score: result.score.toString(),
          },
        ];

        const params = {
          RequestItems: {
            "SentimentData": items.map(item => ({
              PutRequest: {
                Item: {
                  id: { S: item.id },
                  positive_words: { S: item.positive_words },
                  negative_words: { S: item.negative_words },
                  score: { S: item.score },
                },
              },
            })),
          },
        };

        test(params);
    
        // Delete the local sentiment file after successful upload
        fs.unlink(sentimentFilePath, (err) => {
          if (err) {
            console.error(`Error deleting local sentiment file ${sentimentFilePath}:`, err);
          } else {
            console.log(`Local sentiment file ${sentimentFilePath} deleted.`);
          }
        });
      })
      .catch(console.error);

    console.log("Connection closed");
  });

});

function processRawData(rawData) {
  let finalScore1 = 0;
  const positiveWords = [];
  const negativeWords= [];

  rawData.forEach((line) => {
    if (line.trim().length > 0) {
      try {
        const entry = JSON.parse(line);
        finalScore1 += entry.score;

        if (entry.positive && Array.isArray(entry.positive)) {
          positiveWords.push(...entry.positive);
        }
        else if (entry.negative && Array.isArray(entry.negative)){
          negativeWords.push(...entry.negative);
        }
      } catch (error) {
        console.error('Error parsing JSON data:', error.message);
      }
    }
  });

  return {
    score: finalScore1,
    positiveWords: positiveWords,
    negativeWords: negativeWords
  };
}

const test = async (params) => {
  const client = new DynamoDB({});
  console.log("Before writing to DynamoDb");
  try {
    await client.batchWriteItem(params);
    console.log("Write operation successful");
  } catch (error) {
    console.error("Error writing to DynamoDB:", error);
  }
  console.log("After writing to DynamoDb");
};



app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: false }));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));

app.post("/", (req, res) => {
  res.set("Content-Type", "text/xml");
  callId = req.body.From;
  console.log("The caller id is = " + callId);
  res.send(`
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/">
          <Parameter name="number" value="${req.body.From}"/>
        </Stream>
      </Start>
      <Say>I will stream the next 60 seconds of audio through your websocket</Say>
      <Pause length="60" />
    </Response>
  `);
});

console.log("Listening on Port 8080");
server.listen(8080);