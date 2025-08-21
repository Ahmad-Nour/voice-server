const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const FormData = require("form-data");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
require("dotenv").config();
const cors = require("cors");

const app = express();
const server = http.createServer(app);
app.use(cors());
const wss = new WebSocket.Server({
  server,
  clientTracking: true,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3,
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024,
    },
    threshold: 1024,
    concurrencyLimit: 10,
  },
});

const MAX_CONCURRENT_SESSIONS = 2;
const activeSessions = new Map();

app.use(express.json());
app.use(express.static("public"));

const SPEECHMATICS_API_URL = "https://asr.api.speechmatics.com/v2";
const SPEECHMATICS_RT_URL = "wss://eu2.rt.speechmatics.com/v2";
const SPEECHMATICS_API_KEY = process.env.SPEECHMATICS_API_KEY;

if (!SPEECHMATICS_API_KEY) {
  console.error("Speechmatics API key missing");
  process.exit(1);
}

const SUPPORTED_LANGUAGES = {
  ar: "ar",
  en: "en",
  es: "es",
  fr: "fr",
  de: "de",
  it: "it",
  pt: "pt",
  ru: "ru",
  zh: "zh",
  ja: "ja",
  ko: "ko",
};

// Enhanced multer configuration
const upload = multer({
  storage: multer.memoryStorage(), // Use memory instead of disk
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed!'), false);
    }
  }
});

/**
 * -------------------
 * REST: Transcribe file
 * -------------------
 */
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    const language = req.body.language || "ar";
    const formData = new FormData();

    formData.append("config", JSON.stringify({
      type: "transcription",
      transcription_config: {
        language: language,
        operating_point: "enhanced",
        enable_entities: true,
        diarization: "speaker"
      }
    }), { contentType: "application/json" });

    // Append the audio file from memory buffer instead of file path
    formData.append("data_file", req.file.buffer, {
      filename: req.file.originalname || `audio_${Date.now()}`,
      contentType: req.file.mimetype || "audio/mpeg",
      knownLength: req.file.size
    });

    // Remove the cleanup function since we're using memory storage
    // No files are written to disk, so no cleanup needed

    // Create job
    const response = await axios.post(
      `${SPEECHMATICS_API_URL}/jobs`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${SPEECHMATICS_API_KEY}`,
          ...formData.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000 // 2 minute timeout
      }
    );

    const jobId = response.data.id;
    console.log(`Created job ${jobId}`);

    // Polling for job status
    let transcript;
    let attempts = 0;
    const maxAttempts = 30;
    const baseDelay = 3000;

    while (attempts < maxAttempts) {
      const delay = Math.min(baseDelay * Math.pow(2, attempts), 30000);
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        const statusRes = await axios.get(
          `${SPEECHMATICS_API_URL}/jobs/${jobId}`,
          { 
            headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
            timeout: 10000
          }
        );

        const jobStatus = statusRes.data?.job?.status;
        console.log(`Job ${jobId} status: ${jobStatus}`);

        if (jobStatus === "done") {
          const transcriptRes = await axios.get(
            `${SPEECHMATICS_API_URL}/jobs/${jobId}/transcript`,
            { 
              headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
              timeout: 10000
            }
          );
          transcript = transcriptRes.data;
          break;
        } else if (jobStatus === "failed") {
          const errorDetail = statusRes.data?.detail || "Transcription failed";
          console.error(`Job failed: ${errorDetail}`);
          throw new Error(errorDetail);
        }
      } catch (error) {
        console.error(`Polling attempt ${attempts + 1} failed:`, error.message);
        if (attempts === maxAttempts - 1) {
          throw new Error("Failed to get job status: " + error.message);
        }
      }

      attempts++;
    }

    if (!transcript) {
      throw new Error("Failed to get transcript (timed out)");
    }

    res.json({ transcript });
  } catch (error) {
    console.error("Transcription error:", error.message);
    
    let errorDetails = error.response?.data || null;
    if (error.response) {
      console.error("API Response:", error.response.status, error.response.data);
    }
    
    res.status(error.response?.status || 500).json({
      error: error.message,
      details: errorDetails,
    });
  }
});

/**
 * -------------------
 * WebSocket: Real-time transcription
 * -------------------
 */
wss.on("connection", (clientWs, req) => {
  const sessionId = req.headers["sec-websocket-key"];
  console.log(`New connection: ${sessionId}`);

  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
    console.log(`Rejecting session ${sessionId} - server busy`);
    clientWs.send(
      JSON.stringify({
        type: "error",
        message: "Server at capacity. Please try again later.",
      })
    );
    clientWs.close();
    return;
  }

  const session = {
    id: sessionId,
    clientWs,
    speechmaticsWs: null,
    closed: false,
    audioReceived: false, // Track if we've received any audio data
    pingInterval: setInterval(() => {
      if (!session.closed && clientWs.readyState === WebSocket.OPEN) {
        clientWs.ping();
      }
    }, 30000),
  };

  try {
    const urlParams = new URLSearchParams(req.url.split("?")[1] || "");
    const langParam = urlParams.get("lang") || "ar";
    session.language = SUPPORTED_LANGUAGES[langParam] || "ar";
  } catch (e) {
    console.error("Error parsing language:", e);
  }

  activeSessions.set(sessionId, session);

  const setupSpeechmatics = () => {
    try {
      const speechmaticsWs = new WebSocket(SPEECHMATICS_RT_URL, {
        headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
      });

      session.speechmaticsWs = speechmaticsWs;

      speechmaticsWs.on("open", () => {
        console.log(`Speechmatics connected for ${sessionId}`);
        
        // Try different audio format configurations
        const audioFormats = [
          {
            type: "raw",
            sample_rate: 16000,
            encoding: "pcm_s16le", // 16-bit signed integer (most common)
          },
          {
            type: "raw", 
            sample_rate: 16000,
            encoding: "pcm_f32le", // 32-bit float (your current)
          }
        ];

        // Use the first format by default, can be made configurable
        const selectedFormat = audioFormats[0];
        
        speechmaticsWs.send(
          JSON.stringify({
            message: "StartRecognition",
            transcription_config: {
              language: session.language,
              diarization: "none",
              operating_point: "enhanced",
              max_delay_mode: "flexible",
              max_delay: 1,
              enable_partials: true,
              enable_entities: true,
            },
            audio_format: selectedFormat,
          })
        );

        // Send acknowledgment to client
        clientWs.send(
          JSON.stringify({
            type: "ready",
            message: "Ready to receive audio",
            audio_format: selectedFormat,
          })
        );
      });

      speechmaticsWs.on("message", (data) => {
        if (session.closed) return;
        try {
          const msg = JSON.parse(data);
          console.log(`Speechmatics message [${sessionId}]:`, msg.message);

          if (msg.message === "RecognitionStarted") {
            console.log(`Recognition started for ${sessionId}`);
            clientWs.send(
              JSON.stringify({
                type: "recognition_started",
                message: "Speech recognition active",
              })
            );
          } else if (
            msg.message === "AddPartialTranscript" ||
            msg.message === "AddTranscript"
          ) {
            const transcript = msg.metadata?.transcript || "";
            clientWs.send(
              JSON.stringify({
                type: msg.message === "AddTranscript" ? "final" : "partial",
                transcript,
              })
            );
          } else if (msg.message === "AudioAdded") {
            if (!session.audioReceived) {
              session.audioReceived = true;
              console.log(`First audio chunk received for ${sessionId}`);
            }
          } else if (msg.message === "Error") {
            console.error(`Speechmatics error [${sessionId}]:`, msg.reason);
            clientWs.send(
              JSON.stringify({
                type: "error",
                message: msg.reason || "Speechmatics error",
                details: msg,
              })
            );
          } else if (msg.message === "Warning") {
            console.warn(`Speechmatics warning [${sessionId}]:`, msg.reason);
            clientWs.send(
              JSON.stringify({
                type: "warning", 
                message: msg.reason || "Speechmatics warning",
              })
            );
          }
        } catch (e) {
          console.error(`Error processing message [${sessionId}]:`, e);
        }
      });

      speechmaticsWs.on("close", (code, reason) => {
        console.log(`Speechmatics closed [${sessionId}] - Code: ${code}, Reason: ${reason}`);
        if (!session.closed) {
          clientWs.send(
            JSON.stringify({
              type: "speechmatics_disconnected",
              message: "Speechmatics connection closed",
              code,
              reason: reason?.toString(),
            })
          );
        }
      });

      speechmaticsWs.on("error", (err) => {
        console.error(`Speechmatics error [${sessionId}]:`, err);
        if (!session.closed) {
          clientWs.send(
            JSON.stringify({
              type: "error",
              message: "Speechmatics connection error",
              details: err.message,
            })
          );
        }
      });
    } catch (err) {
      console.error(`Setup error [${sessionId}]:`, err);
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: "Failed to setup Speechmatics connection",
          details: err.message,
        })
      );
    }
  };

  clientWs.on("message", (data) => {
    if (session.closed) return;
    
    // Check if this is a text message (configuration) or binary (audio)
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      try {
        // Try to parse as JSON first (configuration messages)
        const parsed = JSON.parse(data.toString());
        console.log(`Received config from client [${sessionId}]:`, parsed);
        // Handle any client configuration here
        return;
      } catch (e) {
        // Not JSON, treat as audio data
      }
    }
    
    // Forward audio data to Speechmatics
    if (session.speechmaticsWs?.readyState === WebSocket.OPEN) {
      session.speechmaticsWs.send(data);
      
      // Log first audio chunk for debugging
      if (!session.audioReceived) {
        console.log(`Forwarding first audio chunk [${sessionId}] - Size: ${data.length} bytes`);
      }
    } else {
      console.warn(`Cannot forward audio - Speechmatics not ready [${sessionId}]`);
    }
  });

  clientWs.on("close", () => {
    console.log(`Client disconnected [${sessionId}]`);
    session.closed = true;
    clearInterval(session.pingInterval);
    if (session.speechmaticsWs) {
      // Send EndOfStream before closing
      if (session.speechmaticsWs.readyState === WebSocket.OPEN) {
        session.speechmaticsWs.send(
          JSON.stringify({ message: "EndOfStream" })
        );
      }
      session.speechmaticsWs.close();
    }
    activeSessions.delete(sessionId);
  });

  clientWs.on("error", (err) => {
    console.error(`Client error [${sessionId}]:`, err);
    session.closed = true;
    clearInterval(session.pingInterval);
    if (session.speechmaticsWs) {
      session.speechmaticsWs.close();
    }
    activeSessions.delete(sessionId);
  });

  setupSpeechmatics();
});

/**
 * -------------------
 * Health check endpoint
 * -------------------
 */
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    activeSessions: activeSessions.size,
    maxSessions: MAX_CONCURRENT_SESSIONS 
  });
});

/**
 * -------------------
 * Misc & startup
 * -------------------
 */
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Active sessions: 0/${MAX_CONCURRENT_SESSIONS}`);
});


app.get('/' ,(req,res) =>{
  res.send('voice-AI Working...')
})