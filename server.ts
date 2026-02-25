import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

const DEEPGRAM_URL =
  "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&language=pt-BR&smart_format=true&interim_results=true&endpointing=500";

type Speaker = "Caller" | "Recipient";

interface TranscriptMessage {
  speaker: Speaker;
  text: string;
  is_final: boolean;
}

interface TrackState {
  ws: WebSocket;
  ready: boolean;
  queue: Buffer[];
}

interface CallState {
  outbound: TrackState | null;
  inbound: TrackState | null;
  browsers: Set<WebSocket>;
}

const calls = new Map<string, CallState>();

function openDeepgramConnection(
  callSid: string,
  speaker: Speaker,
  track: TrackState
): void {
  // Read env var lazily — Next.js loads .env during app.prepare(), so by the
  // time any WebSocket handler runs this is already populated.
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error("[Deepgram] DEEPGRAM_API_KEY is not set — transcription disabled");
    return;
  }

  track.ws.on("open", () => {
    console.log(`[Deepgram] ${speaker} open for ${callSid}`);
    track.ready = true;
    // Flush buffered audio captured while connecting
    for (const chunk of track.queue) {
      track.ws.send(chunk);
    }
    track.queue = [];
  });

  track.ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const alt = msg?.channel?.alternatives?.[0];
      const text: string = alt?.transcript ?? "";
      if (!text.trim()) return;

      const isFinal: boolean = msg.is_final ?? false;
      const payload: TranscriptMessage = { speaker, text, is_final: isFinal };
      const json = JSON.stringify(payload);

      const state = calls.get(callSid);
      if (!state) return;
      for (const browser of state.browsers) {
        if (browser.readyState === WebSocket.OPEN) {
          browser.send(json);
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  track.ws.on("error", (err) => {
    console.error(`[Deepgram] ${speaker} error for ${callSid}:`, err.message);
  });

  track.ws.on("close", (code, reason) => {
    console.log(`[Deepgram] ${speaker} closed for ${callSid} (${code} ${reason})`);
  });
}

function makeTrackState(callSid: string, speaker: Speaker): TrackState {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error("[Deepgram] DEEPGRAM_API_KEY not set");
  }
  const ws = new WebSocket(DEEPGRAM_URL, {
    headers: { Authorization: `Token ${apiKey ?? ""}` },
  });
  const track: TrackState = { ws, ready: false, queue: [] };
  openDeepgramConnection(callSid, speaker, track);
  return track;
}

function sendAudio(track: TrackState | null, audio: Buffer): void {
  if (!track) return;
  if (track.ready && track.ws.readyState === WebSocket.OPEN) {
    track.ws.send(audio);
  } else {
    // Buffer until Deepgram connection opens
    track.queue.push(audio);
  }
}

function handleTwilioStream(ws: WebSocket) {
  let callSid: string | null = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "connected") {
        console.log("[Twilio] Media stream connected");

      } else if (msg.event === "start") {
        callSid = msg.start?.callSid as string;
        console.log(`[Twilio] Stream started for ${callSid}, tracks:`, msg.start?.tracks);

        const state: CallState = {
          outbound: makeTrackState(callSid, "Caller"),
          inbound: makeTrackState(callSid, "Recipient"),
          browsers: calls.get(callSid)?.browsers ?? new Set(),
        };
        calls.set(callSid, state);

      } else if (msg.event === "media" && callSid) {
        const state = calls.get(callSid);
        if (!state) return;

        const track: string = msg.media?.track;
        const payload: string = msg.media?.payload;
        if (!payload) return;

        const audio = Buffer.from(payload, "base64");
        sendAudio(track === "outbound" ? state.outbound : state.inbound, audio);

      } else if (msg.event === "stop" && callSid) {
        console.log(`[Twilio] Stream stopped for ${callSid}`);
        const state = calls.get(callSid);
        if (state) {
          state.outbound?.ws.close();
          state.inbound?.ws.close();
          setTimeout(() => calls.delete(callSid!), 5000);
        }
      }
    } catch (err) {
      console.error("[Twilio] Message parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log(`[Twilio] WebSocket closed${callSid ? ` for ${callSid}` : ""}`);
  });

  ws.on("error", (err) => {
    console.error("[Twilio] WebSocket error:", err.message);
  });
}

function handleBrowserConnection(ws: WebSocket, callSid: string) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      outbound: null,
      inbound: null,
      browsers: new Set(),
    });
  }
  const state = calls.get(callSid)!;
  state.browsers.add(ws);
  console.log(`[Browser] Connected for ${callSid} (${state.browsers.size} listener(s))`);

  ws.on("close", () => {
    state.browsers.delete(ws);
    console.log(`[Browser] Disconnected from ${callSid}`);
  });

  ws.on("error", (err) => {
    console.error(`[Browser] WebSocket error for ${callSid}:`, err.message);
  });
}

app.prepare().then(() => {
  console.log("[Server] Next.js ready, env loaded");
  console.log("[Server] DEEPGRAM_API_KEY set:", !!process.env.DEEPGRAM_API_KEY);

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url ?? "");

    if (pathname !== "/stream" && pathname !== "/transcriptions") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pathname === "/stream") {
        console.log("[WS] Twilio stream connected");
        handleTwilioStream(ws);
      } else if (pathname === "/transcriptions") {
        const { query } = parse(req.url ?? "", true);
        const callSid = Array.isArray(query.callSid)
          ? query.callSid[0]
          : query.callSid;
        if (callSid) {
          handleBrowserConnection(ws, callSid);
        } else {
          ws.close(1008, "Missing callSid");
        }
      } else {
        socket.destroy();
      }
    });
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
