const WebSocket = require("ws");
const express = require("express");
const WaveFile = require("wavefile").WaveFile;

const path = require("path")
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });
const axios = require('axios')

let assembly;
let chunks = [];
let transcribedText = "";

require('dotenv').config(); // Load environment variables from .env file

const ASSEMBLY_APIKEY = process.env.ASSEMBLY_APIKEY

// add twilio
const twilio = require('twilio');
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const fs = require('fs')

// send question to Large language model
async function sendToChatGPT (transcribedText) {
  console.log(`data to send to gpt: ${transcribedText}`);

  const MODEL = 'gpt-3.5-turbo'
  const MAXTOKENS = 4000
  const TEMPERATURE = 0.5 // 0:make nothing up | 2:make anything up

  try {
    const endpoint = 'https://api.openai.com/v1/chat/completions';
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_APIKEY}`
    };

    let prompt = transcribedText

    // Set up the request data
    const data = {
      model: MODEL,
      max_tokens: MAXTOKENS,
      temperature: TEMPERATURE,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ]
    };

    // Send the API request using axios
    const response = await axios.post(endpoint, data, { headers });
    const chatGptResponse = response.data.choices[0].message.content;
    console.log('ChatGPT Response:', chatGptResponse);

    // feed response to twilio
    sendToElevenLabs(chatGptResponse)
  } catch (error) {
    console.error('Error in sendToChatGPT:', error);
  }
}

// Function to send the ChatGPT response to ElevenLabs
async function sendToElevenLabs(responseFromChatGPT) {
  try {
    const XI_API_KEY = process.env.ELEVENLABS_APIKEY;
    const TTS_OUTPUT_PATH = "./output.wav";

    const ttsUrl = "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream"; // Make sure to set `voice-id`

    const ttsHeaders = {
      "Accept": "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": XI_API_KEY
    };

    const ttsData = {
      "text": responseFromChatGPT,
      "model_id": "eleven_monolingual_v1",
      "voice_settings": {
        "stability": 0.5,
        "similarity_boost": 0.5
      }
    };

    const ttsResponse = await axios.post(ttsUrl, ttsData, {
      headers: ttsHeaders,
      responseType: 'stream'
    });

    console.log(ttsResponse);

    // pass along stream to twilio

    const outputStream = fs.createWriteStream(TTS_OUTPUT_PATH);
    ttsResponse.data.pipe(outputStream);

    outputStream.on('finish', () => {
      console.log('ElevenLabs TTS output written successfully.');
    });

  } catch (error) {
    console.error('Error in sendToElevenLabs:', error.message);
  }
}

// Handle Web Socket Connection
wss.on("connection", function connection(ws) {
  console.log("New Connection Initiated");

  ws.on("message", function incoming(message) {
    if (!assembly)
      return console.error("AssemblyAI's WebSocket must be initialized.");

    // Parse the incoming message as JSON
    const msg = JSON.parse(message);
    // console.log(msg.media.payload);
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

        // Create an audio buffer for streaming back to the caller
        const audioBuffer = Buffer.concat(chunks);

        // Broadcast the audio buffer to all connected clients
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(audioBuffer);
          }
        });

        if (chunks.length >= 5) {
          const audioBuffer = Buffer.concat(chunks);
          const encodedAudio = audioBuffer.toString("base64");
          assembly.send(JSON.stringify({ audio_data: encodedAudio }));
          chunks = [];
        }

        // some how we need to find when a person stops talking and then call sendToChatGPT function 

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
       <Connect>
         <Stream url='wss://${req.headers.host}' />
       </Connect>
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