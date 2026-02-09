import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  metrics,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import dotenv from 'dotenv';
import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { fileURLToPath } from 'node:url';
import { Assistant } from './agent.js';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    // Set up a voice AI pipeline using OpenAI, Cartesia, Deepgram, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'multi',
      }),

      // A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
      // See all providers at https://docs.livekit.io/agents/models/llm/
      llm: new inference.LLM({
        model: 'openai/gpt-4.1-mini',
      }),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),

      // VAD and turn detection are used to determine when the user is speaking and when the agent should respond
      // See more at https://docs.livekit.io/agents/build/turns
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      voiceOptions: {
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: true,
      },
    });

    // To use a realtime model instead of a voice pipeline, use the following session setup instead.
    // (Note: This is for the OpenAI Realtime API. For other providers, see https://docs.livekit.io/agents/models/realtime/))
    // 1. Install '@livekit/agents-plugin-openai'
    // 2. Set OPENAI_API_KEY in .env.local
    // 3. Add import `import * as openai from '@livekit/agents-plugin-openai'` to the top of this file
    // 4. Use the following session setup instead of the version above
    // const session = new voice.AgentSession({
    //   llm: new openai.realtime.RealtimeModel({ voice: 'marin' }),
    // });

    // Metrics collection, to measure pipeline performance
    // For more information, see https://docs.livekit.io/agents/build/metrics/
    const usageCollector = new metrics.UsageCollector();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    const logUsage = async () => {
      const summary = usageCollector.getSummary();
      console.log(`Usage: ${JSON.stringify(summary)}`);
    };

    ctx.addShutdownCallback(logUsage);

    // Start the session, which initializes the voice pipeline and warms up the models
    await session.start({
      agent: new Assistant(),
      room: ctx.room,
      inputOptions: {
        // LiveKit Cloud enhanced noise cancellation
        // - If self-hosting, omit this parameter
        // - For telephony applications, use `BackgroundVoiceCancellationTelephony` for best results
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    // Join the room and connect to the user
    await ctx.connect();

    // Greet the user on joining
    session.generateReply({
      instructions: 'Greet the user in a helpful and friendly manner.',
    });
  },
});

// Set up Express server for token generation
const app = express();

// Enable CORS for frontend requests - must be before other middleware
app.use((req, res, next) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
});

app.use(express.json());

// GET /token endpoint to generate LiveKit access tokens
app.get('/token', async (req, res) => {
  // Set CORS headers for this specific route
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  console.log('Token request received:', { room: req.query.room, user: req.query.user });
  
  const { room, user } = req.query;

  if (!room || !user) {
    console.log('Missing parameters:', { room: !!room, user: !!user });
    res.status(400).json({
      error: 'Missing required parameters: room and user are required',
    });
    return;
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  console.log('Environment check:', {
    hasApiKey: !!apiKey,
    hasApiSecret: !!apiSecret,
    hasLivekitUrl: !!livekitUrl,
    livekitUrl,
  });

  if (!apiKey || !apiSecret || !livekitUrl) {
    console.error('Missing LiveKit credentials');
    res.status(500).json({
      error: 'LiveKit credentials not configured. Please set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET',
    });
    return;
  }

  try {
    console.log('Creating AccessToken...');
    const at = new AccessToken(apiKey, apiSecret, {
      identity: user as string,
      name: user as string,
    });

    at.addGrant({
      room: room as string,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    console.log('Generating JWT token...');
    const token = await at.toJwt();
    console.log('Token generated successfully, length:', token.length);

    res.json({
      token,
      serverUrl: livekitUrl,
      room: room as string,
      user: user as string,
    });
  } catch (error) {
    console.error('Error generating token:', error);
    if (error instanceof Error) {
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    }
    res.status(500).json({
      error: 'Failed to generate token',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Start Express server
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Token server running on port ${PORT}`);
  console.log(`GET /token?room=<room_name>&user=<user_name> to generate tokens`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please use a different port.`);
  } else {
    console.error('Server error:', error);
  }
});

// Run the agent server
cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
