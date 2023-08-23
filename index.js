const WebSocket = require("ws");
const express = require("express");
const WaveFile = require("wavefile").WaveFile;

const path = require("path")
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

let assembly;
let chunks = [];
let transcribedText = "";

require('dotenv').config(); // Load environment variables from .env file

const ASSEMBLY_APIKEY = process.env.ASSEMBLY_APIKEY


async function sendToChatGPT (transcribedText) {
  console.log(`data to send to gpt: ${transcribedText}`);


}

// Handle Web Socket Connection
wss.on("connection", function connection(ws) {
  console.log("New Connection Initiated");

  ws.on("message", function incoming(message) {
    if (!assembly)
      return console.error("AssemblyAI's WebSocket must be initialized.");

    // Parse the incoming message as JSON
    const msg = JSON.parse(message);
    // console.log(msg);
    const text = msg.text;
    
    if (msg.message_type === "PartialTranscript") {
      console.log(`Partial transcript received: ${text}`);
    } else if (msg.message_type === "FinalTranscript") {
      console.log(`Final transcript received: ${text}`);
    }

    switch (msg.event) {
      case "connected":
        console.log(`A new call has connected.`);

        // Handle AssemblyAI's messages and errors
        assembly.onerror = console.error;

        // Store transcribed texts along with audio start times
        const texts = {};
        assembly.onmessage = (assemblyMsg) => {
          const res = JSON.parse(assemblyMsg.data);
          texts[res.audio_start] = res.text;

          // Sort keys to ensure correct ordering
          const keys = Object.keys(texts);
          keys.sort((a, b) => a - b);

          // Combine transcribed texts in chronological order
          let msg = '';
          for (const key of keys) {
            if (texts[key]) {
              msg += ` ${texts[key]}`;
            }
          }

          // Store the transcribed text in the variable
          transcribedText = msg;

          // Broadcast interim transcription to all connected clients
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  event: "interim-transcription",
                  text: msg
                })
              );
            }
          });
        };
        break;
      case "start":
        console.log(`Starting Media Stream ${msg.streamSid}`);
        break;
      case "media":
        // Extract raw audio data from Twilio's media payload
        const twilioData = msg.media.payload;

        // Build a WAV file from the raw audio data
        let wav = new WaveFile();
        wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64"));
        wav.fromMuLaw(); // Decode MuLaw to 16-bit PCM

        // Get the raw audio data in base64
        const twilio64Encoded = wav.toDataURI().split("base64,")[1];

        // Create an audio buffer from the base64 encoded data
        const twilioAudioBuffer = Buffer.from(twilio64Encoded, "base64");

        // Send audio data to AssemblyAI, chunking for minimum duration
        chunks.push(twilioAudioBuffer.slice(44));
        if (chunks.length >= 5) {
          const audioBuffer = Buffer.concat(chunks);
          const encodedAudio = audioBuffer.toString("base64");
          assembly.send(JSON.stringify({ audio_data: encodedAudio }));
          chunks = [];
        }
        break;
      case "stop":
        console.log(`Call Has Ended`);

        // Terminate AssemblyAI session
        assembly.send(JSON.stringify({ terminate_session: true }));

        // Log the transcribed text
        // console.log("Transcribed Text after assemblyai terminates:", transcribedText);
        // Send the transcribed data to ChatGPT
        sendToChatGPT(transcribedText);

        break;
    }        
  });
});


// Handle GET requests - this will likely be the login
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));

// Handle POST requests for starting the transcription process
app.post("/", async (req, res) => {
  // Initialize a WebSocket connection to AssemblyAI's real-time API
  assembly = new WebSocket(
    "wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000",
    { 
      headers: { 
        authorization: `${ASSEMBLY_APIKEY}` 
      } 
    }
  );

  // Set response content type to XML
  res.set("Content-Type", "text/xml");

  // Respond with TwiML instructions
  res.send(
    `<Response>
       <Start>
         <Stream url='wss://${req.headers.host}' />
       </Start>
       <Say>
         Start speaking to see your audio transcribed in the console
       </Say>
       <Pause length='30' />
     </Response>`
  );
});

// Start server
console.log("Listening at Port 8080");
server.listen(8080);