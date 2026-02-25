import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";

const VoiceResponse = twilio.twiml.VoiceResponse;

export async function POST(request: NextRequest) {
  const callerId = process.env.TWILIO_CALLER_ID;

  if (!callerId) {
    return new NextResponse("Missing TWILIO_CALLER_ID env variable", {
      status: 500,
    });
  }

  // Twilio sends form-encoded data
  const formData = await request.formData();
  const to = formData.get("To") as string;

  if (!to) {
    return new NextResponse("Missing 'To' parameter", { status: 400 });
  }

  const host = request.headers.get("host") ?? "localhost:3000";
  const twiml = new VoiceResponse();
  const start = twiml.start();
  start.stream({ url: `wss://${host}/stream`, track: "both_tracks" });
  const dial = twiml.dial({ callerId });
  dial.number(to);

  return new NextResponse(twiml.toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
