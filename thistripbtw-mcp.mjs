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

/* ── reading one back ──────────────────────────────────────────────────────────────────────
   The inverse of buildLink, and the reason it exists: a format you can only WRITE is not a
   format. Until this, an assistant handed a trip link could do nothing with it — not summarise
   it, not add a stop, not convert it. The payload is in the link, so this needs no network and
   no key, exactly like building one.

   The distinction that matters, and the one people will trip over: a DRAFT link carries the
   whole trip in its #d= fragment and can be read here. A KEPT trip's link is /{slug}/#k=phrase
   — that fragment is a password, not a payload, and its contents live on the server behind it.
   Saying so plainly is better than "malformed input". */
function readLink(input) {
  const raw = String((input && input.link) || "").trim();
  if (!raw) throw new Error("no link given");

  let b64;
  const at = raw.indexOf("#d=");
  if (at >= 0) b64 = raw.slice(at + 3);
  else if (/#k=/.test(raw))
    throw new Error("that is a kept trip's link — the #k= fragment is its password, not the trip. Its contents live on the server and only the people holding that link can read them; there is nothing here to decode");
  else if (/https?:\/\//i.test(raw))
    throw new Error("that URL carries no trip — a readable trip link has a #d= fragment holding the itinerary");
  else b64 = raw;                       // a bare payload is fine

  b64 = b64.split(/[?&\s#]/)[0];
  if (!b64) throw new Error("the link has an empty #d= fragment");

  let payload;
  try {
    const pad = b64.replace(/-/g, "+").replace(/_/g, "/");
    payload = JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
  } catch (e) {
    throw new Error("that fragment did not decode to a trip — it may have been truncated when the link was pasted");
  }
  if (!payload || typeof payload !== "object" || !payload.o || !Array.isArray(payload.l))
    throw new Error("that decoded, but it is not shaped like a trip");

  /* Back into the shape build_trip_link ACCEPTS, not the compact one it emits, so a caller can
     read a trip, change one field and pass the result straight back without translating. */
  const trip = {
    name: payload.n || "",
    origin: payload.o,
    legs: payload.l.map((l) => {
      const out = { to: l.to, mode: l.mode || "drive" };
      for (const k of ["date", "note", "who", "subtype", "craft", "flight"])
        if (l[k] !== undefined) out[k] = l[k];
      if (l.stay && l.stay.lodging) {
        out.lodging = l.stay.lodging;
        if (l.stay.note) out.stayNote = l.stay.note;
      }
      return out;
    }),
  };

  const where = (p) => (p && p.name) || "an unnamed place";
  const lines = trip.legs.map((l, i) => {
    const bits = [l.date, l.mode, l.flight, l.who && l.who.length ? l.who.join(" & ") : null,
                  l.lodging ? `stay: ${l.lodging}` : null].filter(Boolean);
    return `${i + 1}. ${where(l.to)}${bits.length ? "  —  " + bits.join(" · ") : ""}`;
  });
  const summary =
    `${trip.name || "Untitled trip"} — ${trip.legs.length} leg${trip.legs.length === 1 ? "" : "s"}\n` +
    `Starts: ${where(trip.origin)}\n` + lines.join("\n");

  return { trip, summary, legs: trip.legs.length };
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
  // A when-clause plus the phrases a person actually says, because the model matches this text
  // against the live conversation rather than against a feature list. (Chosen by blind test:
  // several candidate descriptions were tried in a real client and this one triggered when it
  // should and stayed quiet when it should not.)
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

const READ_TOOL = {
  name: "read_trip_link",
  description:
    "Use when someone gives you a this trip, btw link and you need to know what is actually in " +
    "it — to summarise the plan, answer a question about it, add a stop, or convert it to " +
    "something else. Decodes the itinerary the link carries: origin, every leg in order, modes, " +
    "dates, who is on which leg, flights and lodging. Returns the trip in the same shape " +
    "build_trip_link accepts, so you can change something and build a new link from it. Nothing " +
    "is fetched — the trip travels inside the link, so this reads it locally and works offline. " +
    "Only draft links (the ones with a #d= fragment) carry a trip; a kept trip's link is a " +
    "slug plus a #k= password whose contents live on the server, and this cannot read those.",
  inputSchema: {
    type: "object",
    properties: {
      link: { type: "string",
        description: "The trip link, e.g. https://thistripbtw.us/new#d=… — the whole URL is fine, or just the fragment." },
    },
    required: ["link"],
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
      /* Kept in step with package.json BY HAND — this string is what a client is told when it
         asks, and it said 1.0.0 for the whole life of 1.1.0, which is the release that added
         read_trip_link. A client feature-detecting on version would have concluded the tool
         was not there. */
      serverInfo: { name: "thistripbtw", version: "1.1.1" },
    });
  }
  if (method === "tools/list") return ok(id, { tools: [TOOL, READ_TOOL] });
  /* Only `tools` is declared, so a spec-following client never asks for these — and -32601 is
     the correct answer when it does. Scanners ask anyway: Smithery's 2026-08-03 scan logged both
     failures as WARNINGS on the public listing, which reads as a broken server rather than a
     capability we never claimed. An empty list is true and does not look broken. */
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "prompts/list")   return ok(id, { prompts: [] });
  if (method === "ping")       return ok(id, {});

  if (method === "tools/call") {
    if (params?.name === READ_TOOL.name) {
      try {
        const { trip, summary, legs } = readLink(params.arguments || {});
        return ok(id, { content: [{ type: "text",
          text: `${summary}\n\nAs build_trip_link arguments:\n` +
                "```json\n" + JSON.stringify(trip, null, 2) + "\n```" }] });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `Could not read that: ${e.message}` }], isError: true });
      }
    }
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
    const names = out.result.tools.map((x) => x.name);
    if (!names.includes("build_trip_link")) throw new Error("no build tool");
    if (!names.includes("read_trip_link")) throw new Error("no read tool");
  });

  /* read_trip_link. The round trip is the one that matters: what build emits, read must
     return in the shape build accepts, or "change one thing and rebuild" does not work. */
  t("reads back a link it just built", () => {
    const { trip: back } = readLink({ link: buildLink(trip).url });
    if (back.name !== trip.name) throw new Error("lost the name");
    if (back.origin.name !== "Chicago, IL") throw new Error("lost the origin");
    if (back.legs.length !== trip.legs.length) throw new Error("lost legs");
  });
  t("survives a full build → read → build round trip", () => {
    const once = buildLink(trip).url;
    const twice = buildLink(readLink({ link: once }).trip).url;
    if (once !== twice) throw new Error("round trip is not stable");
  });
  t("flattens stay back to the lodging build accepts", () => {
    const url = buildLink({ ...trip, legs: [{ to: trip.legs[0].to, lodging: "Hotel Maverick", stayNote: "late check-in" }] }).url;
    const l = readLink({ link: url }).trip.legs[0];
    if (l.lodging !== "Hotel Maverick" || l.stayNote !== "late check-in") throw new Error("lost the stay");
    if ("stay" in l) throw new Error("left the nested shape build would ignore");
  });
  t("takes a bare fragment as well as a whole URL", () => {
    const frag = buildLink(trip).url.split("#d=")[1];
    if (readLink({ link: frag }).legs !== trip.legs.length) throw new Error("bare payload failed");
  });
  throws("says a kept trip's link is a password, not a payload",
    () => readLink({ link: "https://thistripbtw.us/abcdefg/#k=one-two-three-four" }), "password");
  throws("refuses a URL with no trip in it",
    () => readLink({ link: "https://thistripbtw.us/new" }), "carries no trip");
  throws("refuses a truncated fragment", () => readLink({ link: "#d=not-base64!!" }), "did not decode");
  throws("refuses valid base64 that is not a trip",
    () => readLink({ link: Buffer.from('{"hello":1}').toString("base64") }), "not shaped like a trip");
  throws("refuses an empty link", () => readLink({ link: "" }), "no link given");

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
