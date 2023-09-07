const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require('axios');
const WaveFile = require("wavefile").WaveFile;
const fs = require('fs');
const path = require("path");
const twilio = require('twilio');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let assembly;
let chunks = [];
let transcribedText = "";
let streamId = "";
let currentCallSid = "";
let ws = "";

const ASSEMBLY_APIKEY = process.env.ASSEMBLY_APIKEY;
const assemblyVoiceId = "21m00Tcm4TlvDq8ikWAM";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const XI_API_KEY = process.env.ELEVENLABS_APIKEY;

const TWILIO_AUDIO_CHUNK_THRESHOLD = 5;

const MODEL = 'gpt-3.5-turbo';
const MAXTOKENS = 4000;
const TEMPERATURE = 0.5;

const endpoint = 'https://api.openai.com/v1/chat/completions';

const chatGptHeaders = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${process.env.OPENAI_APIKEY}`
};

const ttsHeaders = {
  'Accept': 'audio/mpeg',
  'Content-Type': 'application/json',
  'xi-api-key': XI_API_KEY
};

const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${assemblyVoiceId}/stream`;

const appPort = 8080;

// Initialize Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);


// Send question to Large language model
async function sendToChatGPT(transcribedText) {
  console.log(`Transcribed Text: ${transcribedText}`);

  try {
    const data = {
      model: MODEL,
      max_tokens: MAXTOKENS,
      temperature: TEMPERATURE,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: transcribedText }
      ]
    };

    const response = await axios.post(endpoint, data, { headers: chatGptHeaders });
    const chatGptResponse = response.data.choices[0].message.content;
    console.log('ChatGPT Response:', chatGptResponse);

    sendToElevenLabs(chatGptResponse, currentCallSid);
  } catch (error) {
    console.error('Error in sendToChatGPT:', error);
  }
}

// Function to send audio data to Twilio
function sendAudioToTwilio(audioData) {
  const base64AudioData = Buffer.from(audioData).toString('base64');

  const message = {
    event: 'media',
    streamSid: streamId,
    media: {
      payload: base64AudioData,
    },
  };

  ws.send(JSON.stringify(message));
}

// Function to send the ChatGPT response to ElevenLabs
async function sendToElevenLabs(responseFromChatGPT, currentCallSid) {
  try {
    const ttsData = {
      "text": responseFromChatGPT,
      "model_id": "eleven_monolingual_v1",
      "voice_settings": {
        "stability": 0.5,
        "similarity_boost": 0.5
      }
    };



    const ttsResponse = await axios.post(ttsUrl, ttsData, { headers: ttsHeaders, responseType: 'stream' });

    

    // Handle data events from the ElevenLabs stream and send it to Twilio
    ttsResponse.data.on('data', (chunk) => {
      sendAudioToTwilio(chunk);
    });

    // Handle the end of the ElevenLabs stream
    ttsResponse.data.on('end', () => {
      console.log('ElevenLabs TTS stream ended.');
      // You can perform any cleanup or additional actions here.
    });

    // Handle errors from the ElevenLabs stream
    ttsResponse.data.on('error', (error) => {
      console.error('Error in ElevenLabs TTS stream:', error);
      // You can handle errors as needed.
    });
  } catch (error) {
    console.error('Error in sendToElevenLabs:', error.message);
  }
}

async function initBotResponse() {
  // Terminate AssemblyAI session
  assembly.send(JSON.stringify({ terminate_session: true }));
  // Send the transcribed data to ChatGPT
  await sendToChatGPT(transcribedText);
  console.log('Init bot complete');
}

wss.on("connection", function connection(connection) {
  console.log("New Connection Initiated");
  ws = connection;

  ws.on("message", function incoming(message) {
    if (!assembly)
      return console.error("AssemblyAI's WebSocket must be initialized.");

    const msg = JSON.parse(message);
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

        setTimeout(function() {initBotResponse()}, 5000);
        break;
      case "start":
        console.log(`Starting Media Stream ${msg.streamSid}`);
        streamId = msg.streamSid;
        currentCallSid  = msg.start.callSid;
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

        if (chunks.length >= TWILIO_AUDIO_CHUNK_THRESHOLD) {
          const audioBuffer = Buffer.concat(chunks);
          const encodedAudio = audioBuffer.toString("base64");
          assembly.send(JSON.stringify({ audio_data: encodedAudio }));
          chunks = [];
        }
        break;
      case "stop":
        console.log(`Call Has Ended`);
        assembly.send(JSON.stringify({ terminate_session: true }));
        break;
    }        
  });
});
// Handle GET requests - this will likely be the login
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));


let streamUrl = "";
// Handle POST requests for starting the transcription process
app.post("/", async (req, res) => {
  try {
    streamUrl = `${req.headers.host}/audio`;

    assembly = new WebSocket(
      "wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000",
      {
        headers: {
          authorization: ASSEMBLY_APIKEY
        }
      }
    );

    res.set("Content-Type", "text/xml");

    res.send(
      `<Response>
         <Connect>
           <Stream url='wss://${streamUrl}' />
         </Connect>
         <Say>
           Start speaking to see your audio transcribed in the console
         </Say>
         <Pause length='30' />
       </Response>`
    );
  } catch (error) {
    console.error("Error in POST request:", error);
    res.status(500).send("Internal Server Error");
  }
});
// Start server
server.listen(8080, () => {
  console.log("Server is listening on port 8080");
});