const WebSocket = require("ws");
const express = require("express");
const fs = require("fs");
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

let callSid = "";


playBotResponse = (ws, streamId) => {
  // Load the output.wav file from your root directory
  const audioFilePath = './output.wav'; // Update with the correct path if needed
  const audioData = fs.readFileSync(audioFilePath);

  // Base64 encode the audio data
  const base64AudioData = Buffer.from(audioData).toString("base64");

  // Create a message object with the "media" event and audio payload
  const message = {
    event: "media",
    streamSid: streamId, // Replace with your streamSid
    media: {
      payload: base64AudioData
    }
  };
  console.log(message);

  // Send the message as a JSON string to the WebSocket client
  ws.send(JSON.stringify(message));
}

// Handle Web Socket Connection
wss.on("connection", function connection(ws) {
  console.log("New Connection Initiated", ws);
    
  ws.on("message", function incoming(message) {
    const msg = JSON.parse(message);

    switch (msg.event) {
      case "connected":
        console.log(`A new call has connected.`);
        break;
    case "start":
        console.log(msg.start.callSid);
        console.log(`Starting Media Stream ${msg.streamSid}`);
        if (msg.start.callSid) {
            console.log(`Call ID (CallSid) for this media stream: ${msg.start.callSid}`);
            callSid = msg.start.callSid
        }
        // setTimeout(function() {playBotResponse(ws, msg.streamSid)}, 2000);
        break;
      case "media":
        // console.log(`Receiving Audio...`)
        // console.log(msg);

        // if the  user talking 
          // process a response
        // else the bot should be talking 
          // stream an output
        break;
      case "stop":
        console.log(`Call Has Ended`);
        break;
    }
  });
    
});

//Handle HTTP Request
app.get("/", (req, res) => res.send("Hello World"));

app.post("/", (req, res) => {
    res.set("Content-Type", "text/xml");
  
    res.send(`
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/"/>
        </Connect>
        <Say>I will stream the next 60 seconds of audio through your websocket</Say>
        <Pause length="60" />
      </Response>
    `);
});

console.log("Listening at Port 8080");
server.listen(8080);