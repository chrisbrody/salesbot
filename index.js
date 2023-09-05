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
let streamId = "";
let currentCallSid = "";
let ws = "";
const websocketStreamUrl = 'wss://https://3cef-67-241-88-254.ngrok-free.app/audio';

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
  console.log(`Transcribed Text: ${transcribedText}`);

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
    sendToElevenLabs(chatGptResponse, currentCallSid)
  } catch (error) {
    console.error('Error in sendToChatGPT:', error);
  }
}


// Function to send the ChatGPT response to ElevenLabs
async function sendToElevenLabs(responseFromChatGPT, currentCallSid) {
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

    const outputStream = fs.createWriteStream(TTS_OUTPUT_PATH);
    ttsResponse.data.pipe(outputStream);

    return new Promise((resolve, reject) => {
      outputStream.on('finish', async () => {
        console.log('ElevenLabs TTS output written successfully.');

        // Check if the output.wav file exists
        if (fs.existsSync(TTS_OUTPUT_PATH)) {
          try {
            await sendRawAudio(currentCallSid, websocketStreamUrl); // Use websocketStreamUrl here
            console.log('Finished sending audio over WebSocket');
            resolve();
          } catch (error) {
            reject(error);
          }
        } else {
          console.log('output.wav file does not exist.');
          resolve();
        }
      });

      outputStream.on('error', error => {
        console.error('Error writing TTS output:', error);
        reject(error);
      });
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

  console.log('init bot complete');
}

async function sendRawAudio(callSid, streamUrl) {
  console.log('send raw audio');
  console.log(callSid);
  console.log(streamUrl);

  try {
    // Load the output.wav file from your root directory
    const audioFilePath = './output.wav'; // Update with the correct path if needed
    const audioData = fs.readFileSync(audioFilePath);

    // streaming data coming in frm ELEVENLABS 
    // convert that to base 64 and add to payload
    
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

    console.log('Finished sending audio to Twilio');
  } catch (error) {
    console.error('Error in sendRawAudio:', error);
  }
}
async function sendAudioOverWebSocket(streamUrl) {
  // Check if the WebSocket connection is established
  if (!ws) {
    console.error("WebSocket connection not established.");
    return;
  }

  // Send the audio chunks over the WebSocket connection
  chunks.forEach(chunk => {
    ws.send(chunk);
  });

  console.log('Finished sending audio over WebSocket');
}


// Handle Web Socket Connection
wss.on("connection", function connection(connection) {
  console.log("New Connection Initiated");
  // Assign the WebSocket instance to the global variable
  ws = connection;
  // console.log(client);

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

        // if there has been 3s of time, send the message
        // Log the transcribed text
        setTimeout(function() {initBotResponse()}, 5000);

        break;
      case "start":
        console.log(`Starting Media Stream ${msg.streamSid}`);
        streamId = msg.streamSid
        currentCallSid  = msg.start.callSid
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

        break;
      case "stop":
        console.log(`Call Has Ended`);

        // Terminate AssemblyAI session
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