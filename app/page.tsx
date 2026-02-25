"use client";

import { useEffect, useRef, useState } from "react";
import type { Call, Device } from "@twilio/voice-sdk";

type CallStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "connecting"
  | "ringing"
  | "in-progress"
  | "disconnected"
  | "error";

type Speaker = "Caller" | "Recipient";

interface TranscriptEntry {
  id: number;
  speaker: Speaker;
  text: string;
  is_final: boolean;
}

const STATUS_LABELS: Record<CallStatus, string> = {
  idle: "Loading...",
  initializing: "Initializing device...",
  ready: "Ready",
  connecting: "Connecting...",
  ringing: "Ringing...",
  "in-progress": "In progress",
  disconnected: "Call ended",
  error: "Error",
};

const STATUS_COLORS: Record<CallStatus, string> = {
  idle: "#999",
  initializing: "#f0a500",
  ready: "#22c55e",
  connecting: "#3b82f6",
  ringing: "#3b82f6",
  "in-progress": "#22c55e",
  disconnected: "#999",
  error: "#ef4444",
};

const SPEAKER_COLORS: Record<Speaker, string> = {
  Caller: "#22c55e",
  Recipient: "#3b82f6",
};

export default function Home() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const transcriptWsRef = useRef<WebSocket | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const entryCountRef = useRef(0);

  useEffect(() => {
    let device: Device;

    async function setup() {
      setStatus("initializing");
      try {
        const res = await fetch("/api/token");
        if (!res.ok) throw new Error("Failed to fetch access token");
        const { token } = await res.json();

        const { Device } = await import("@twilio/voice-sdk");
        device = new Device(token, { logLevel: 1 });

        device.on("error", (err: Error) => {
          setStatus("error");
          setErrorMessage(err.message);
        });

        await device.register();
        deviceRef.current = device;
        setStatus("ready");
      } catch (err) {
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Unknown error");
      }
    }

    setup();

    return () => {
      device?.destroy();
    };
  }, []);

  // Auto-scroll transcript to bottom
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  function openTranscriptSocket(callSid: string) {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${window.location.host}/transcriptions?callSid=${callSid}`
    );

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as {
          speaker: Speaker;
          text: string;
          is_final: boolean;
        };

        setTranscript((prev) => {
          // If interim: update the last entry for this speaker if it's also interim
          if (!msg.is_final) {
            const last = prev[prev.length - 1];
            if (last && last.speaker === msg.speaker && !last.is_final) {
              return [
                ...prev.slice(0, -1),
                { ...last, text: msg.text },
              ];
            }
            entryCountRef.current += 1;
            return [
              ...prev,
              {
                id: entryCountRef.current,
                speaker: msg.speaker,
                text: msg.text,
                is_final: false,
              },
            ];
          }

          // Final: mark last matching interim as final, or add new entry
          const last = prev[prev.length - 1];
          if (last && last.speaker === msg.speaker && !last.is_final) {
            return [
              ...prev.slice(0, -1),
              { ...last, text: msg.text, is_final: true },
            ];
          }
          entryCountRef.current += 1;
          return [
            ...prev,
            {
              id: entryCountRef.current,
              speaker: msg.speaker,
              text: msg.text,
              is_final: true,
            },
          ];
        });
      } catch {
        // ignore
      }
    };

    ws.onerror = (err) => {
      console.error("Transcription WS error", err);
    };

    transcriptWsRef.current = ws;
  }

  function closeTranscriptSocket() {
    transcriptWsRef.current?.close();
    transcriptWsRef.current = null;
  }

  async function handleCall() {
    if (!deviceRef.current || !phoneNumber.trim()) return;
    setStatus("connecting");
    setErrorMessage("");
    setTranscript([]);
    try {
      const call = await deviceRef.current.connect({
        params: { To: phoneNumber.trim() },
      });
      callRef.current = call;

      call.on("ringing", () => setStatus("ringing"));
      call.on("accept", () => {
        setStatus("in-progress");
        const callSid = (call.parameters as Record<string, string>).CallSid;
        if (callSid) {
          openTranscriptSocket(callSid);
        }
      });
      call.on("disconnect", () => {
        closeTranscriptSocket();
        callRef.current = null;
        setStatus("ready");
      });
      call.on("error", (err: Error) => {
        closeTranscriptSocket();
        callRef.current = null;
        setStatus("error");
        setErrorMessage(err.message);
      });
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
    }
  }

  function handleHangup() {
    callRef.current?.disconnect();
    callRef.current = null;
    closeTranscriptSocket();
    setStatus("ready");
  }

  const isCallActive =
    status === "connecting" || status === "ringing" || status === "in-progress";
  const canCall = status === "ready" && phoneNumber.trim().length > 0;

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <h1 style={styles.title}>Twilio Caller</h1>

        {/* Status badge */}
        <div style={styles.statusRow}>
          <span
            style={{ ...styles.dot, backgroundColor: STATUS_COLORS[status] }}
          />
          <span style={styles.statusText}>{STATUS_LABELS[status]}</span>
        </div>

        {errorMessage && <p style={styles.errorText}>{errorMessage}</p>}

        {/* Phone number input */}
        <input
          type="tel"
          placeholder="+1 (555) 000-0000"
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          disabled={isCallActive}
          style={styles.input}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCall) handleCall();
          }}
        />

        {/* Call / Hang Up buttons */}
        <div style={styles.buttonRow}>
          {!isCallActive ? (
            <button
              onClick={handleCall}
              disabled={!canCall}
              style={{
                ...styles.button,
                ...styles.callButton,
                opacity: canCall ? 1 : 0.4,
                cursor: canCall ? "pointer" : "not-allowed",
              }}
            >
              Call
            </button>
          ) : (
            <button
              onClick={handleHangup}
              style={{ ...styles.button, ...styles.hangupButton }}
            >
              Hang Up
            </button>
          )}
        </div>

        <p style={styles.hint}>
          Use E.164 format — e.g. <code style={styles.code}>+15551234567</code>
        </p>

        {/* Transcript panel */}
        {(isCallActive || transcript.length > 0) && (
          <div style={styles.transcriptPanel}>
            <div style={styles.transcriptHeader}>
              <span style={styles.transcriptTitle}>Live Transcript</span>
              <span style={styles.speakerLegend}>
                <span style={{ color: SPEAKER_COLORS.Caller }}>● Caller</span>
                &nbsp;&nbsp;
                <span style={{ color: SPEAKER_COLORS.Recipient }}>
                  ● Recipient
                </span>
              </span>
            </div>
            <div style={styles.transcriptBody}>
              {transcript.length === 0 && (
                <p style={styles.transcriptPlaceholder}>
                  Waiting for speech...
                </p>
              )}
              {transcript.map((entry) => (
                <div key={entry.id} style={styles.transcriptEntry}>
                  <span
                    style={{
                      ...styles.speakerLabel,
                      color: SPEAKER_COLORS[entry.speaker],
                    }}
                  >
                    {entry.speaker}
                  </span>
                  <span
                    style={{
                      ...styles.transcriptText,
                      opacity: entry.is_final ? 1 : 0.55,
                    }}
                  >
                    {entry.text}
                  </span>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: 60,
    paddingBottom: 60,
    backgroundColor: "#0f0f0f",
    fontFamily: "var(--font-geist-sans), sans-serif",
  },
  card: {
    backgroundColor: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: 16,
    padding: "40px 48px",
    width: 480,
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  title: {
    margin: 0,
    fontSize: 24,
    fontWeight: 600,
    color: "#fff",
    letterSpacing: "-0.5px",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
  statusText: {
    fontSize: 14,
    color: "#aaa",
  },
  errorText: {
    margin: 0,
    fontSize: 13,
    color: "#ef4444",
    backgroundColor: "#2d0a0a",
    padding: "8px 12px",
    borderRadius: 8,
  },
  input: {
    padding: "12px 16px",
    fontSize: 16,
    borderRadius: 10,
    border: "1px solid #333",
    backgroundColor: "#111",
    color: "#fff",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  buttonRow: {
    display: "flex",
    gap: 12,
  },
  button: {
    flex: 1,
    padding: "13px",
    fontSize: 15,
    fontWeight: 600,
    borderRadius: 10,
    border: "none",
    transition: "opacity 0.15s",
  },
  callButton: {
    backgroundColor: "#22c55e",
    color: "#fff",
  },
  hangupButton: {
    backgroundColor: "#ef4444",
    color: "#fff",
    cursor: "pointer",
  },
  hint: {
    margin: 0,
    fontSize: 12,
    color: "#555",
    textAlign: "center",
  },
  code: {
    fontFamily: "var(--font-geist-mono), monospace",
    color: "#888",
  },
  // Transcript styles
  transcriptPanel: {
    border: "1px solid #2a2a2a",
    borderRadius: 10,
    overflow: "hidden",
  },
  transcriptHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    backgroundColor: "#111",
    borderBottom: "1px solid #2a2a2a",
  },
  transcriptTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  speakerLegend: {
    fontSize: 11,
    color: "#555",
  },
  transcriptBody: {
    maxHeight: 260,
    overflowY: "auto",
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  transcriptPlaceholder: {
    margin: 0,
    fontSize: 13,
    color: "#444",
    fontStyle: "italic",
  },
  transcriptEntry: {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
  },
  speakerLabel: {
    fontSize: 11,
    fontWeight: 700,
    flexShrink: 0,
    paddingTop: 2,
    minWidth: 60,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  transcriptText: {
    fontSize: 14,
    color: "#ddd",
    lineHeight: 1.5,
  },
};
