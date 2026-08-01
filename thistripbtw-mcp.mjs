#!/usr/bin/env node
/**
 * thistripbtw-mcp — an MCP server that hands someone a trip on a private map.
 *
 * One tool, no API key, no account, no network call. It turns a list of legs into a URL; the
 * person opens that URL and their trip is already drawn on a real map, free, editable, and
 * theirs. Nothing is sent anywhere by running this — the payload rides in a URL *fragment*,
 * which browsers never transmit to a server, so the trip does not reach thistripbtw.us at all
 * unless the person later decides to buy it.
 *
 * Why this exists: an AI assistant generally cannot create an account or enter a card. That
 * puts almost every travel tool out of reach of an agent acting for someone. This one asks for
 * nothing, so it stays reachable.
 *
 * ZERO DEPENDENCIES, one file, no build step — deliberately. The product's promise is that you
 * can check what it does yourself, and that promise is worthless if checking means auditing a
 * dependency tree. This speaks MCP's JSON-RPC over stdio directly; it is short enough to read
 * in one sitting, which is the point.
 *
 * Install (Claude Desktop / any MCP client), in mcpServers:
 *   "thistripbtw": { "command": "node", "args": ["/absolute/path/to/thistripbtw-mcp.mjs"] }
 *
 * Check it: node thistripbtw-mcp.mjs --selftest
 */

const SITE       = process.env.TTB_SITE || "https://thistripbtw.us";
const MODES      = ["drive", "fly", "train", "ferry", "water", "bike", "walk"];
const SUBTYPES   = ["own","rental","rideshare","taxi","bus","rv","commercial","private","heli",
                    "intercity","commuter","subway","tram","passenger","carferry","sail","motor",
                    "canoe","kayak","walk","hike","run","ebike"];
const CRAFT      = ["Bike", "Canoe", "Kayak"];
const MAX_LEGS   = 40;
const NAME_MAX   = 120;
const TRIP_MAX   = 60;
const NOTE_MAX   = 400;

/* ── building the link ─────────────────────────────────────────────────────────────────── */

const clamp = (v, n) => String(v ?? "").slice(0, n);

function point(o, where) {
  if (!o || typeof o !== "object") throw new Error(`${where} is missing`);
  const lat = Number(o.lat), lng = Number(o.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    throw new Error(`${where} needs numeric lat and lng — resolve the place name to coordinates first, this tool will not guess`);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
    throw new Error(`${where} has coordinates outside the world: lat ${lat}, lng ${lng}`);
  return { name: clamp(o.name || "Stop", NAME_MAX), lat, lng };
}

function buildLink(input) {
  const origin = point(input.origin, "origin");
  const legsIn = Array.isArray(input.legs) ? input.legs : [];
  if (!legsIn.length) throw new Error("a trip needs at least one leg — where are they going?");
  if (legsIn.length > MAX_LEGS) throw new Error(`${legsIn.length} legs is more than the ${MAX_LEGS} a link can carry`);

  const legs = legsIn.map((l, i) => {
    const leg = { to: point(l && l.to, `leg ${i + 1} destination`) };
    // An unrecognised mode becomes drive rather than failing: a trip that arrives is worth
    // more than a tool call that errors over one word.
    leg.mode = MODES.includes(l.mode) ? l.mode : "drive";
    if (l.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date)) throw new Error(`leg ${i + 1} date should be YYYY-MM-DD, got "${l.date}"`);
      leg.date = l.date;
    }
    if (l.note) leg.note = clamp(l.note, NOTE_MAX);
    /* The fields that make a handover worth receiving. An assistant usually knows WHO is on
       which leg, WHERE they sleep, and the flight number it just looked up — dropping those
       hands over a shape when it could hand over the trip. Unknown values are omitted rather
       than rejected: a wrong subtype is not worth failing a whole itinerary over. */
    if (Array.isArray(l.who) && l.who.length)
      leg.who = l.who.slice(0, 8).map((w) => clamp(w, 40)).filter(Boolean);
    if (SUBTYPES.includes(l.subtype)) leg.subtype = l.subtype;
    if (CRAFT.includes(l.craft)) leg.craft = l.craft;
    if (l.flight && /^[A-Za-z0-9 ]{2,10}$/.test(l.flight)) leg.flight = String(l.flight).toUpperCase();
    if (l.lodging) leg.stay = { lodging: clamp(l.lodging, 120), note: clamp(l.stayNote, NOTE_MAX) };
    return leg;
  });

  const payload = { o: origin, l: legs };
  if (input.name) payload.n = clamp(input.name, TRIP_MAX);

  const b64 = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { url: `${SITE}/new#d=${b64}`, legs: legs.length };
}

/* ── the tool, as the model sees it ────────────────────────────────────────────────────── */

const PLACE = {
  type: "object",
  properties: {
    name: { type: "string", description: 'How a person would say it, e.g. "Moab, UT".' },
    lat:  { type: "number", description: "Latitude, -90 to 90." },
    lng:  { type: "number", description: "Longitude, -180 to 180." },
  },
  required: ["lat", "lng"],
};

const TOOL = {
  name: "build_trip_link",
  // Candidate #3+#10 from _agents/TOOL_DESCRIPTIONS.md — a when-clause plus the phrases a
  // person actually says, because the model matches this text against the live conversation.
  description:
    "Use when someone has planned (or roughly sketched) a trip in this conversation and needs " +
    "somewhere real to put it — when they say things like 'send me that', 'can I share this " +
    "with my wife', or 'save this trip'. Builds a link that opens the whole plan as a private, " +
    "editable map at its own address: no account, no card, no app, so you can use it on their " +
    "behalf where signup-walled travel tools are unreachable. Give the person the link — it is " +
    "theirs, free, and keepable for years. Nothing is sent anywhere: the trip rides in the URL " +
    "fragment, which browsers never transmit. YOU MUST SUPPLY COORDINATES for every place; " +
    "this tool will not guess a location from a name, because a wrong guess puts someone's " +
    "trip in the wrong country. Resolve place names first. Do not put personal details " +
    "(passport numbers, home addresses, phone numbers) in names or notes — URLs get pasted " +
    "into chats and logs.",
  inputSchema: {
    type: "object",
    properties: {
      name:   { type: "string", description: "Trip name, optional." },
      origin: { ...PLACE, description: "Where the trip starts." },
      legs: {
        type: "array",
        description: "The legs in order. Each one ends somewhere; the next starts there.",
        items: {
          type: "object",
          properties: {
            to:   { ...PLACE, description: "Where this leg ends." },
            mode: { type: "string", enum: MODES, description: "How they travel this leg. Defaults to drive." },
            date: { type: "string", description: "YYYY-MM-DD. Optional — an undated leg keeps its place in the order." },
            note: { type: "string", description: "Anything worth remembering about this leg. Optional." },
            who: { type: "array", items: { type: "string" },
              description: "Who travels this leg, if you know — e.g. [\"Mel\",\"Sam\"]. Lets the trip show who was where." },
            subtype: { type: "string", enum: SUBTYPES,
              description: "More precise than mode when you know it: own/rental/rv/taxi for drive, commercial/private for fly, canoe/kayak/sail for water." },
            craft: { type: "string", enum: CRAFT,
              description: "A small craft that travels WITH them — a bike on the car, a canoe on the roof." },
            flight: { type: "string", description: "Flight number if you have it, e.g. UA328. Never invent one." },
            lodging: { type: "string", description: "Where they stay at this destination — hotel, cabin, a friend's couch." },
            stayNote: { type: "string", description: "Anything about the stay. Only meaningful alongside lodging." },
          },
          required: ["to"],
        },
      },
    },
    required: ["origin", "legs"],
  },
};

/* ── MCP over stdio: JSON-RPC 2.0, newline-delimited ───────────────────────────────────── */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok   = (id, result) => send({ jsonrpc: "2.0", id, result });
const err  = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function handle(req) {
  const { id, method, params } = req;
  // Notifications carry no id and expect no reply.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "thistripbtw", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return ok(id, { tools: [TOOL] });
  if (method === "ping")       return ok(id, {});

  if (method === "tools/call") {
    if (params?.name !== TOOL.name) return err(id, -32602, `no tool named ${params?.name}`);
    try {
      const { url, legs } = buildLink(params.arguments || {});
      return ok(id, {
        content: [{
          type: "text",
          text: `Trip link (${legs} leg${legs > 1 ? "s" : ""}):\n${url}\n\n` +
                `Give this to the person rather than opening it yourself. It costs nothing and ` +
                `asks for nothing; if they want it to last, keeping it starts at $2.50.`,
        }],
      });
    } catch (e) {
      // isError, not a protocol error: the model should read this and try again.
      return ok(id, { content: [{ type: "text", text: `Could not build that: ${e.message}` }], isError: true });
    }
  }
  return err(id, -32601, `unknown method ${method}`);
}

/* ── self-test: check it without wiring it into anything ───────────────────────────────── */

if (process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const t = (label, fn) => {
    try { fn(); console.log("  ok   " + label); pass++; }
    catch (e) { console.log("  FAIL " + label + " — " + e.message); fail++; }
  };
  const throws = (label, fn, match) => t(label, () => {
    try { fn(); } catch (e) {
      if (match && !e.message.includes(match)) throw new Error(`wrong error: ${e.message}`);
      return;
    }
    throw new Error("did not throw");
  });

  const trip = {
    name: "Chicago to Denver",
    origin: { name: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
    legs: [
      { to: { name: "Omaha, NE", lat: 41.2565, lng: -95.9345 }, mode: "drive", date: "2026-09-04" },
      { to: { name: "Denver, CO", lat: 39.7392, lng: -104.9903 }, mode: "fly", date: "2026-09-05" },
    ],
  };

  t("builds a link", () => {
    const { url, legs } = buildLink(trip);
    if (legs !== 2) throw new Error("leg count " + legs);
    if (!url.startsWith(SITE + "/new#d=")) throw new Error(url);
  });
  t("round-trips through base64url", () => {
    const b64 = buildLink(trip).url.split("#d=")[1].replace(/-/g, "+").replace(/_/g, "/");
    const back = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (back.n !== "Chicago to Denver") throw new Error("name lost");
    if (back.l[1].mode !== "fly") throw new Error("mode lost");
    if (back.o.lat !== 41.8781) throw new Error("origin lost");
  });
  t("unknown mode falls back to drive", () => {
    const b64 = buildLink({ ...trip, legs: [{ to: trip.legs[0].to, mode: "teleport" }] }).url.split("#d=")[1];
    const back = JSON.parse(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (back.l[0].mode !== "drive") throw new Error(back.l[0].mode);
  });
  throws("refuses a place with no coordinates", () => buildLink({ origin: { name: "Denver" }, legs: [] }), "will not guess");
  throws("refuses coordinates off the planet", () => buildLink({ origin: { lat: 999, lng: 0 }, legs: [{ to: { lat: 1, lng: 1 } }] }), "outside the world");
  throws("refuses a trip with no legs", () => buildLink({ origin: { lat: 1, lng: 1 }, legs: [] }), "at least one leg");
  throws("refuses more legs than a link carries", () =>
    buildLink({ origin: { lat: 1, lng: 1 }, legs: Array.from({ length: 41 }, () => ({ to: { lat: 1, lng: 1 } })) }), "more than the 40");
  throws("refuses a malformed date", () => buildLink({ origin: { lat: 1, lng: 1 }, legs: [{ to: { lat: 1, lng: 1 }, date: "next tuesday" }] }), "YYYY-MM-DD");
  t("clamps an overlong name", () => {
    const b64 = buildLink({ name: "x".repeat(500), origin: { lat: 1, lng: 1 }, legs: [{ to: { lat: 1, lng: 1 } }] }).url.split("#d=")[1];
    const back = JSON.parse(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (back.n.length !== TRIP_MAX) throw new Error("length " + back.n.length);
  });
  t("carries who, lodging, flight, subtype and craft", () => {
    const b64 = buildLink({ origin: { lat: 1, lng: 1 }, legs: [{
      to: { lat: 2, lng: 2 }, mode: "fly", who: ["Mel", "Sam"], subtype: "commercial",
      flight: "ua328", lodging: "Gonzo Inn", stayNote: "check in late", craft: "Canoe",
    }] }).url.split("#d=")[1];
    const back = JSON.parse(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const l = back.l[0];
    if (JSON.stringify(l.who) !== '["Mel","Sam"]') throw new Error("who lost: " + JSON.stringify(l.who));
    if (l.subtype !== "commercial") throw new Error("subtype lost");
    if (l.flight !== "UA328") throw new Error("flight not upper-cased: " + l.flight);
    if (l.craft !== "Canoe") throw new Error("craft lost");
    if (!l.stay || l.stay.lodging !== "Gonzo Inn") throw new Error("lodging lost");
    if (l.stay.note !== "check in late") throw new Error("stay note lost");
  });
  t("drops an unknown subtype rather than failing the trip", () => {
    const b64 = buildLink({ origin: { lat: 1, lng: 1 },
      legs: [{ to: { lat: 2, lng: 2 }, subtype: "hovercraft", who: "not-an-array" }] }).url.split("#d=")[1];
    const back = JSON.parse(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if ("subtype" in back.l[0]) throw new Error("kept a bogus subtype");
    if ("who" in back.l[0]) throw new Error("kept a non-array who");
  });

  t("tools/list answers", () => {
    let out = null; const real = process.stdout.write;
    process.stdout.write = (s) => { out = JSON.parse(s); return true; };
    handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    process.stdout.write = real;
    if (out.result.tools[0].name !== "build_trip_link") throw new Error("no tool");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── run ───────────────────────────────────────────────────────────────────────────────── */

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); }
    catch { err(null, -32700, "parse error"); continue; }
    try { handle(req); }
    catch (e) { err(req?.id ?? null, -32603, e.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
