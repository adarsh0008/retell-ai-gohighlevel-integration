/**
 * Retell AI -> GoHighLevel (GHL) integration
 *
 * Receives Retell AI webhooks and, when a call has been analyzed:
 *   1. Creates or updates the caller as a GHL contact (upsert by phone/email)
 *   2. Tags the contact (e.g. "ai-call", sentiment, custom tags)
 *   3. Adds a note with the AI call summary, sentiment and transcript
 *
 * Author: Adarsh Shukla (https://github.com/adarsh0008)
 */
require("dotenv").config();
const express = require("express");
const { Retell } = require("retell-sdk");

const {
  PORT = 3000,
  RETELL_API_KEY,
  GHL_PRIVATE_TOKEN,
  GHL_LOCATION_ID,
  GHL_DEFAULT_TAGS = "ai-call,retell-ai",
} = process.env;

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

const app = express();
app.use(express.json({ limit: "5mb" }));

/** Small helper for authenticated GHL API v2 requests */
async function ghl(path, method, body) {
  const res = await fetch(GHL_BASE_URL + path, {
    method,
    headers: {
      Authorization: "Bearer " + GHL_PRIVATE_TOKEN,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error("GHL " + method + " " + path + " failed (" + res.status + "): " + JSON.stringify(data));
  }
  return data;
}

/** Pick the customer's phone number based on call direction */
function getCustomerPhone(call) {
  return call.direction === "outbound" ? call.to_number : call.from_number;
}

/** Build tags from defaults + sentiment + optional dynamic variable "tags" */
function buildTags(call) {
  const tags = GHL_DEFAULT_TAGS.split(",").map((t) => t.trim()).filter(Boolean);
  const sentiment = call.call_analysis && call.call_analysis.user_sentiment;
  if (sentiment) tags.push("sentiment-" + String(sentiment).toLowerCase());
  const extra = call.retell_llm_dynamic_variables && call.retell_llm_dynamic_variables.tags;
  if (extra) tags.push(...String(extra).split(",").map((t) => t.trim()));
  return [...new Set(tags)];
}

/** Format the note that is saved on the GHL contact */
function buildNote(call) {
  const a = call.call_analysis || {};
  const lines = [
    "📞 AI Call (Retell AI) — " + (call.direction || "call"),
    "Call ID: " + call.call_id,
    a.call_summary ? "\nSummary:\n" + a.call_summary : "",
    a.user_sentiment ? "\nSentiment: " + a.user_sentiment : "",
    a.custom_analysis_data ? "\nExtracted data:\n" + JSON.stringify(a.custom_analysis_data, null, 2) : "",
    call.recording_url ? "\nRecording: " + call.recording_url : "",
    call.transcript ? "\nTranscript:\n" + call.transcript : "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function syncCallToGhl(call) {
  const vars = call.retell_llm_dynamic_variables || {};
  const extracted = (call.call_analysis && call.call_analysis.custom_analysis_data) || {};

  // 1) Upsert contact (GHL matches on phone/email based on your location settings)
  const { contact } = await ghl("/contacts/upsert", "POST", {
    locationId: GHL_LOCATION_ID,
    phone: getCustomerPhone(call),
    firstName: extracted.first_name || vars.first_name,
    lastName: extracted.last_name || vars.last_name,
    email: extracted.email || vars.email,
    source: "Retell AI Voice Agent",
  });

  // 2) Add tags
  await ghl("/contacts/" + contact.id + "/tags", "POST", { tags: buildTags(call) });

  // 3) Add call summary + transcript as a note
  await ghl("/contacts/" + contact.id + "/notes", "POST", { body: buildNote(call) });

  return contact.id;
}

app.post("/webhooks/retell", async (req, res) => {
  // Verify the request really comes from Retell AI
  const signature = req.headers["x-retell-signature"];
  if (!Retell.verify(JSON.stringify(req.body), RETELL_API_KEY, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Acknowledge quickly; Retell retries on slow/failed responses
  res.status(204).end();

  const { event, call } = req.body;
  if (event !== "call_analyzed") return; // summary & sentiment are ready on this event

  try {
    const contactId = await syncCallToGhl(call);
    console.log("✅ Synced call " + call.call_id + " to GHL contact " + contactId);
  } catch (err) {
    console.error("❌ Failed to sync call " + (call && call.call_id) + ":", err.message);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log("Retell -> GHL webhook listening on port " + PORT));
