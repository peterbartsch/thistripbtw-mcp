#!/usr/bin/env node
/**
 * thistripbtw-mcp — an MCP server that hands someone a trip on a private map.
 *
 * Three tools, no API key and no account. `build_trip_link` turns a list of legs into a URL; the
 * person opens that URL and their trip is already drawn on a real map, free, editable, and
 * theirs. `read_trip_link` turns such a link back into legs. Neither sends anything anywhere —
 * the payload rides in a URL *fragment*, which browsers never transmit to a server, so a trip
 * built here does not reach thistripbtw.us at all unless the person later decides to buy it.
 *
 * `read_kept_trip` IS THE EXCEPTION, and it is the only one. A trip somebody has BOUGHT lives on
 * the server, and the `#k=` part of its link is the password to it rather than the trip itself —
 * so reading one means sending that phrase to thistripbtw.us. There is no version of this that
 * works offline, which is why the other two say "no network" and this one cannot. It stores
 * nothing and needs no account.
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

/* `legs` arrives as a STRING more often than you would think — a client that double-encodes, or a
   model that hand-wrote the JSON with a stray quote. Both used to fall through `Array.isArray`
   to an empty list and the reply was "a trip needs at least one leg", which sent one model off to
   re-plan a trip that was fine. (Its own words, 2026-09-10: "That's a misleading error, since the
   real problem was a parse failure.") So: try to read a string as JSON, and if the legs are
   present but not a list, say THAT. */
function legsOf(input) {
  let legs = input.legs;
  if (typeof legs === "string") {
    try { legs = JSON.parse(legs); }
    catch (e) { throw new Error(`legs arrived as text that is not valid JSON (${e.message}) — this usually means a quote is unbalanced or the array was encoded twice. Send legs as a JSON array, not a string`); }
  }
  if (legs === undefined || legs === null) return [];
  if (!Array.isArray(legs)) throw new Error(`legs must be an array — got ${typeof legs}. Each leg is an object with a "to" place`);
  legs.forEach((l, i) => {
    if (l === null || typeof l !== "object" || Array.isArray(l))
      throw new Error(`leg ${i + 1} is ${l === null ? "null" : Array.isArray(l) ? "an array" : "a " + typeof l}, not an object with a "to" place`);
  });
  return legs;
}

function buildLink(input) {
  const origin = point(input.origin, "origin");
  const legsIn = legsOf(input);
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

/* ── the ceiling nobody here can enforce ───────────────────────────────────────────────────
   The whole trip rides in the fragment, so the link grows with the itinerary: a twelve-leg
   trip measures about 3,000 characters and many chat clients wrap or truncate a pasted URL
   near 2,000. `/new` has had a ceiling for this since it shipped — over its decoder's limit it
   refuses and says "keep it instead and share that" — and this server had none, so it handed
   back links that break in the channel they exist to travel through.

   It is a NOTE, not an error. The link is valid and shorter channels carry it fine; what the
   caller needs is to know before they paste, because the failure lands on the RECIPIENT, who
   gets a truncated fragment and no way back to whoever built it. readLink() already names that
   cause on the way in ("it may have been truncated when the link was pasted") — this is the
   same fact, delivered early enough to act on.

   Kept byte-identical to mcp_long_link_note() in lib/mcp.php (D-081). */
const LINK_SOFT_MAX = 2000;
function longLinkNote(url) {
  if (url.length <= LINK_SOFT_MAX) return "";
  return `\n\nHeads-up: this link is ${url.length.toLocaleString("en-US")} characters, and many ` +
         `chat apps cut a link near ${LINK_SOFT_MAX.toLocaleString("en-US")}. If it has to travel ` +
         `through one, say so — keeping the trip turns it into a short link that cannot be cut.`;
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

/* ── amend: one link grows through a conversation instead of a new one every turn ─────────
   The model's own account of why it did not reach for the tool first (2026-09-10): "Each change
   means a new link. There's no way to update an existing trip, so building early feels like
   making links you'll throw away." This is read → merge → build, pure, no network — so a rough
   route can become a link at the FIRST message and be rebuilt every time the plan moves. */
function amendLink(input) {
  const { trip } = readLink({ link: input.link });
  const next = { name: trip.name, origin: trip.origin, legs: trip.legs.slice() };
  if (input.name   !== undefined) next.name   = input.name;
  if (input.origin !== undefined) next.origin = input.origin;
  if (input.legs   !== undefined) next.legs   = legsOf({ legs: input.legs });     // REPLACES
  const add = legsOf({ legs: input.add });
  if (add.length) next.legs = next.legs.concat(add);                              // APPENDS
  if (input.remove !== undefined) {
    const idx = Number(input.remove);
    if (!Number.isInteger(idx) || idx < 1 || idx > next.legs.length)
      throw new Error(`remove must be a leg number from 1 to ${next.legs.length}`);
    next.legs.splice(idx - 1, 1);
  }
  const built = buildLink(next);
  return { ...built, changed: { name: input.name !== undefined, origin: input.origin !== undefined,
           replaced: input.legs !== undefined, added: add.length, removed: input.remove !== undefined } };
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

/* One leg schema, shared by build and amend — two copies would drift the moment a field landed
   in one and not the other, and the parity test compares tools/list, not intent. */
const LEG = {
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
};

const TOOL = {
  name: "build_trip_link",
  // A when-clause plus the phrases a person actually says, because the model matches this text
  // against the live conversation rather than against a feature list. (Chosen by blind test:
  // several candidate descriptions were tried in a real client and this one triggered when it
  // should and stayed quiet when it should not.)
  /* THE FIRST 80 CHARACTERS ARE THE WHOLE DESCRIPTION for a client that defers tools — that is
     all a model sees before deciding whether to look closer. The previous opening, "Use when
     someone has planned (or roughly sketched) a trip…", told a model this was a finishing step,
     and it obeyed: it researched for four turns and built the link last, when the person asked.
     Rewritten 2026-09-10 from that model's own report of why it did not reach for this first. */
  description:
    "Start here for any trip, road trip or itinerary. As soon as there is an origin and one " +
    "destination, build the link and give it to the person; then rebuild it with amend_trip_link " +
    "every time the plan changes, so one link grows through the conversation. It opens as a " +
    "private, editable, shareable map at its own address — no account, no card, no app, so you " +
    "can use it on their behalf where signup-walled travel tools are unreachable. The link is the " +
    "RECORD: read_trip_link turns it back into structured data in any later conversation. Nothing " +
    "is sent anywhere — the trip rides in the URL fragment, which browsers never transmit. " +
    "Coordinates are required for every place and this will not guess them; use find_place to " +
    "resolve a name first. Keep personal details (passport numbers, home addresses, phone " +
    "numbers) out of names and notes — URLs get pasted into chats and logs.",
  inputSchema: {
    type: "object",
    properties: {
      name:   { type: "string", description: "Trip name, optional." },
      origin: { ...PLACE, description: "Where the trip starts." },
      legs: {
        type: "array",
        description: "The legs in order. Each one ends somewhere; the next starts there.",
        items: LEG,
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

const AMEND_TOOL = {
  name: "amend_trip_link",
  description:
    "Update a trip link you already built — add legs, replace them, rename, or drop one — and get " +
    "the new link back. Use this instead of building a fresh link every time the plan changes, so " +
    "the person holds one link that grows. Takes a draft link (#d=) plus the changes; no network, " +
    "no password, the trip is inside the link. For a KEPT trip (#k=) use add_to_kept_trip.",
  inputSchema: {
    type: "object",
    properties: {
      link:   { type: "string", description: "The existing draft link, whole URL or just the #d= fragment." },
      add:    { type: "array", items: LEG, description: "Legs to APPEND after the last one." },
      legs:   { type: "array", items: LEG, description: "REPLACES every leg. Omit to keep them." },
      remove: { type: "integer", description: "Drop leg number N (1-based). Applied after add/legs." },
      name:   { type: "string", description: "New trip name." },
      origin: { ...PLACE, description: "New starting point." },
    },
    required: ["link"],
  },
};

const FIND_TOOL = {
  name: "find_place",
  description:
    "Turn a place name into coordinates for build_trip_link — towns, cities, airports (IATA or " +
    "name), parks, trailheads. Returns up to six candidates with lat/lng and where each one is, " +
    "so you can pick the right Reno. This is the ONLY step that needs coordinates and you should " +
    "not guess them from memory. It asks thistripbtw.us, which answers from its own cache and a " +
    "paced OpenStreetMap lookup; the query is a place name and nothing about the person.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: 'The place as a person would say it: "Moab, UT", "SFO", "Arches National Park".' },
    },
    required: ["query"],
  },
};

const ADD_TOOL = {
  name: "add_to_kept_trip",
  description:
    "Add a stop to a trip the person has KEPT (a link with #k=), on their behalf. Use when they " +
    "say 'add X to the trip', 'we're stopping at Y on the way', 'put the hotel on it'. Needs their " +
    "EDIT phrase — a view phrase can read but not write, and the tool says so. Writes exactly one " +
    "stop and returns the trip's current stop count. Like read_kept_trip this touches the network: " +
    "the #k= phrase is the password and it goes to thistripbtw.us over TLS, nothing is stored " +
    "about you, and a wrong phrase counts as a guess. Treat the link as a credential.",
  inputSchema: {
    type: "object",
    properties: {
      link:  { type: "string", description: "The kept trip's link with its #k= EDIT phrase." },
      stop:  { type: "object", description: "The stop to add.",
        properties: {
          name:  { type: "string", description: "What to call it, e.g. \"Fisher Towers trailhead\"." },
          lat:   { type: "number" }, lng: { type: "number" },
          date:  { type: "string", description: "YYYY-MM-DD, optional." },
          mode:  { type: "string", enum: MODES, description: "How they get there. Defaults to drive." },
          note:  { type: "string", description: "Anything worth remembering. Optional." },
          track: { type: "string", description: "Which vehicle, if the trip has more than one: as named by read_kept_trip." },
        },
        required: ["lat", "lng"] },
    },
    required: ["link", "stop"],
  },
};

const KEPT_TOOL = {
  name: "read_kept_trip",
  description:
    "Use when someone gives you a KEPT this trip, btw link — one that looks like " +
    "https://thistripbtw.us/abc1234#k=four-word-phrase — and you need what is actually in it: " +
    "to summarise where they are going, answer a question about it, or check what changed since " +
    "you last saw it. Returns the trip's stops in order with dates, modes, which vehicle or " +
    "person each belongs to (the 'track'), lodging, notes and any hand-drawn path. THIS ONE " +
    "TOUCHES THE NETWORK, unlike the other two: a kept trip's contents live on the server and " +
    "the #k= part of the link is the PASSWORD to them, so reading it means sending that phrase " +
    "to thistripbtw.us over TLS. Nothing is stored and no account is involved. Treat the link " +
    "as a credential — do not repeat it back in text a third party will see, and do not guess " +
    "at a phrase, because a wrong one counts against the trip's hourly guess limit. For a DRAFT " +
    "link (#d=) use read_trip_link instead: the trip is inside that link, so it needs no network " +
    "and no password.",
  inputSchema: {
    type: "object",
    properties: {
      link: { type: "string",
        description: "The kept trip's link, e.g. https://thistripbtw.us/abc1234#k=treeline-downpour-rolling-switchback. The whole URL is fine." },
    },
    required: ["link"],
  },
};

/* ── reading a KEPT trip ───────────────────────────────────────────────────────────────────
   The third tool, and the only one that touches the network — deliberately, and it is the one
   place in this file where "nothing is sent anywhere" stops being true. It cannot be otherwise:
   a kept trip's contents live on the server, and the `#k=` fragment is the PASSWORD to them
   rather than the trip itself. So this sends that phrase to the origin that already receives it
   whenever the person opens their own link, over TLS, and stores nothing.

   WHAT IT DELIBERATELY DOES NOT DO, because each of these was available and wrong:

   - It does NOT return the raw state response. That payload carries a `tiles` token (a per-trip
     offline basemap, which IS a map of where somebody is going) and a member ROSTER WITH IDS,
     which are what the revoke call takes. Neither is itinerary and neither belongs in an agent's
     context, so this names the fields it passes through and drops the rest.
   - It does NOT flatten to build_trip_link's origin+legs shape. A kept trip has TRACKS — two
     vehicles that separate and rejoin — and a two-track trip cannot be written as one sequence
     without becoming false. It returns the `stops` shape trip.json already documents, which
     keeps `track` and is stable.
   - It does NOT sort. Reading order and travel order are different here: dates rule, and an
     undated stop holds its place within its OWN track. `seq` and `track` come through so a
     caller can see the real order rather than a flattened guess.
   - It does NOT retry a rejected phrase. A wrong Bearer counts against the trip's guess limiter
     (30/hour), and while a CORRECT phrase is never locked out, burning somebody's budget on
     retries is not this tool's business. One attempt, then say so plainly. */

const KEPT_RE = /^[A-Za-z0-9_-]{4,40}$/;

function keptParts(input) {
  const raw = String((input && input.link) || "").trim();
  if (!raw) throw new Error("no link given");
  if (/#d=/.test(raw))
    throw new Error("that is a DRAFT link — it carries the trip inside it, so use read_trip_link, which needs no network and no password");

  const hash = raw.indexOf("#k=");
  if (hash < 0)
    throw new Error("that link has no #k= phrase. A kept trip's link looks like https://thistripbtw.us/abc1234#k=four-word-phrase — the part after #k= is its password, and without it there is nothing to ask for");
  const phrase = raw.slice(hash + 3).split(/[?&\s#]/)[0].trim().toLowerCase();
  if (!phrase) throw new Error("the #k= fragment is empty");

  /* The slug is the last path segment before the fragment. Accepts /abc1234 and /abc1234/ and a
     bare abc1234#k=…, because all three get pasted — and STRIPS A QUERY STRING FIRST, because a
     real link out of somebody's address bar carries one: /efevnwm?pmdiag=1&cb=3#k=… is what a
     diagnostic session leaves behind, and reading the slug as "efevnwm?pmdiag=1&cb=3" fails on a
     link that is perfectly valid. */
  const before = raw.slice(0, hash).split("?")[0].replace(/\/+$/, "");
  const slug = before.split("/").filter(Boolean).pop() || "";
  if (!KEPT_RE.test(slug))
    throw new Error(`could not find the trip's address in that link — got "${slug || "nothing"}" before the #k=`);
  return { slug, phrase };
}

/** Only these fields leave the server through this tool. Anything added to the API later has to
 *  be added here on purpose, which is the point of an allowlist over a delete-list. */
const KEPT_STOP_FIELDS = ["kind", "track", "seq", "date", "title", "lat", "lng", "mode", "craft",
                          "fly", "lodging", "notes", "spotify", "author", "path"];

async function readKept(input, fetchImpl = globalThis.fetch) {
  const { slug, phrase } = keptParts(input);
  const url = `${SITE}/${slug}/api/trip/state`;

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${phrase}`, Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`could not reach ${SITE} to read that trip (${e.name === "TimeoutError" ? "timed out" : e.message}). Unlike the other two tools this one needs the network, because a kept trip's contents are on the server`);
  }

  if (res.status === 401) throw new Error("not it — that phrase is not accepted for this trip. Check with whoever sent you the link. This counted as one guess against the trip's hourly limit, so it was not retried");
  if (res.status === 410) throw new Error("that trip reached its end date and was deleted. Every tier has one, so this is the product working rather than a fault");
  if (res.status === 404) throw new Error("no trip lives at that address");
  if (!res.ok) throw new Error(`the server answered ${res.status} reading that trip`);

  let s;
  try { s = await res.json(); } catch { throw new Error("the server's answer was not readable as a trip"); }

  /* DELETED PINS ARRIVE HERE AND MUST BE DROPPED. `trip/state` does not filter them — the polling
     client needs to learn that something went away, so a deletion is a row with `deleted:1` rather
     than an absence. An itinerary that lists them is simply wrong. This was written without the
     filter and the first live test still passed, because that trip happened to have none: a clean
     result is a date, not a guarantee. */
  const stops = (Array.isArray(s.pins) ? s.pins : [])
    .filter((p) => !p.deleted)
    .map((p) => {
      const out = {};
      for (const k of KEPT_STOP_FIELDS) if (p[k] !== undefined && p[k] !== null && p[k] !== "") out[k] = p[k];
      return out;
    });

  const trip = {
    address: `${SITE}/${slug}`,
    name: (s.config && s.config.name) || "",
    access: s.access || "",
    tier: s.tier || "",
    expires: typeof s.expires === "number" ? new Date(s.expires).toISOString().slice(0, 10) : null,
    tracks: (s.config && s.config.labels) || null,
    stops,
    notes: (Array.isArray(s.notes) ? s.notes : [])
      .filter((n) => !n.deleted)                       // same reason as the stops filter above
      .map((n) => n.text ?? n.body ?? "").filter(Boolean),
  };

  const dated = stops.filter((p) => p.date).map((p) => p.date).sort();
  const lines = stops.map((p, i) =>
    `${i + 1}. ${p.title || "an unnamed place"}` +
    [p.date, p.track ? `track ${p.track}` : null, p.mode, p.lodging ? `stay: ${p.lodging}` : null]
      .filter(Boolean).map((b) => `  —  ${b}`).join(""));

  const summary =
    `${trip.name || "Untitled trip"} — ${stops.length} stop${stops.length === 1 ? "" : "s"}` +
    (dated.length ? `, ${dated[0]} to ${dated[dated.length - 1]}` : ", no dates set") +
    `\nYou are reading it with ${trip.access === "edit" ? "an EDIT phrase" : "a VIEW phrase"}` +
    (trip.expires ? `, and it ends ${trip.expires}` : "") + ".\n" +
    (lines.length ? lines.join("\n") : "Nothing has been added to it yet.") +
    `\n\nAnything left sealed for somebody else comes back with empty text: it was never readable ` +
    `by this phrase and is not readable here.`;

  return { trip, summary, stops: stops.length };
}

/* ── find_place: the coordinates step, done for the model instead of by it ─────────────────
   The model that skipped this tool said: "It needs coordinates for every stop, which suggests
   doing research before calling it," and admitted the Fisher Towers point came from memory.
   This asks our geocoder — a cache in front of a paced Nominatim — the same thing the site's own
   search field asks. A place name is not personal data; the privacy page already lists the
   sub-processor. */
const UA = "thistripbtw-mcp/1.3.1";
function placeQuery(input) {
  const q = String((input && input.query) || "").trim();
  if (!q) throw new Error("no place given — send a name like \"Moab, UT\" or an airport code");
  if (q.length > 120) throw new Error("that query is longer than a place name");
  return q;
}
async function findPlace(input, fetchImpl = globalThis.fetch) {
  const q = placeQuery(input);
  let res;
  try {
    res = await fetchImpl(`${SITE}/api/geocode?q=${encodeURIComponent(q)}`,
      { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`could not reach ${SITE} to look that up (${e.name === "TimeoutError" ? "timed out" : e.message})`);
  }
  if (!res.ok) throw new Error(`the server answered ${res.status} looking that up`);
  let d; try { d = await res.json(); } catch { throw new Error("the server's answer was not readable"); }
  const results = (Array.isArray(d.results) ? d.results : []).slice(0, 6).map((r) => ({
    name: r.name, where: r.full, lat: r.lat, lng: r.lon,
  }));
  if (!results.length) throw new Error(`nothing found for "${q}" — try adding the state or country, or an airport's IATA code`);
  const lines = results.map((r, i) => `${i + 1}. ${r.name} — ${r.lat}, ${r.lng}\n   ${r.where}`);
  return { results, summary: `${results.length} match${results.length === 1 ? "" : "es"} for "${q}":\n` + lines.join("\n") +
    (results.length > 1 ? "\n\nPick the one in the right region; the first is not always it." : "") };
}

/* ── add_to_kept_trip: the write half of D-172 ────────────────────────────────────────────
   Same auth as reading: the phrase goes as a Bearer token to the same API the browser uses, so
   there is exactly one write path and one limiter. The server decides whether the phrase may
   write; this never assumes it can. */
async function addToKept(input, fetchImpl = globalThis.fetch) {
  const { slug, phrase } = keptParts(input);
  const st = (input && input.stop) || {};
  const pt = point(st, "the stop");
  const body = {
    kind: "stop", title: pt.name, lat: pt.lat, lng: pt.lng,
    date: st.date || null, mode: MODES.includes(st.mode) ? st.mode : "drive",
    notes: clamp(st.note || "", 4000), track: st.track || null, author: "",
  };
  if (body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new Error("date must be YYYY-MM-DD");
  let res;
  try {
    res = await fetchImpl(`${SITE}/${slug}/api/trip/pins`, {
      method: "POST",
      headers: { Authorization: `Bearer ${phrase}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`could not reach ${SITE} to add that stop (${e.name === "TimeoutError" ? "timed out" : e.message})`);
  }
  if (res.status === 401) throw new Error("not it — that phrase is not accepted for this trip. This counted as one guess against the trip's hourly limit");
  if (res.status === 403) throw new Error("that is a VIEW phrase — it can read this trip but not add to it. Ask the person for the edit link");
  if (res.status === 410) throw new Error("that trip reached its end date and was deleted");
  if (res.status === 404) throw new Error("no trip lives at that address");
  if (!res.ok) throw new Error(`the server answered ${res.status} adding that stop`);
  const { trip } = await readKept(input, fetchImpl);
  return { id: (await res.json().catch(() => ({}))).id || null, stops: trip.stops.length,
    summary: `Added "${pt.name}" to ${trip.name || "the trip"}. It now has ${trip.stops.length} stop${trip.stops.length === 1 ? "" : "s"}.` };
}

/* ── MCP over stdio: JSON-RPC 2.0, newline-delimited ───────────────────────────────────── */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok   = (id, result) => send({ jsonrpc: "2.0", id, result });
const err  = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(req) {
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
      serverInfo: { name: "thistripbtw", version: "1.3.1" },
    });
  }
  if (method === "tools/list") return ok(id, { tools: [TOOL, FIND_TOOL, AMEND_TOOL, READ_TOOL, KEPT_TOOL, ADD_TOOL] });
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
    if (params?.name === FIND_TOOL.name) {
      try { const { summary, results } = await findPlace(params.arguments || {});
        return ok(id, { content: [{ type: "text", text: `${summary}\n\nAs data:\n` + "```json\n" + JSON.stringify(results, null, 2) + "\n```" }] });
      } catch (e) { return ok(id, { content: [{ type: "text", text: `Could not find that: ${e.message}` }], isError: true }); }
    }
    if (params?.name === AMEND_TOOL.name) {
      try { const { url, legs, changed } = amendLink(params.arguments || {});
        const what = [changed.added ? `added ${changed.added}` : null, changed.removed ? "removed one" : null,
                      changed.replaced ? "replaced the legs" : null, changed.name ? "renamed" : null, changed.origin ? "moved the start" : null]
                     .filter(Boolean).join(", ") || "no change";
        return ok(id, { content: [{ type: "text", text: `Trip link (${legs} leg${legs === 1 ? "" : "s"}, ${what}):\n${url}\n\nThis replaces the earlier link — give the person this one.` + longLinkNote(url) }] });
      } catch (e) { return ok(id, { content: [{ type: "text", text: `Could not amend that: ${e.message}` }], isError: true }); }
    }
    if (params?.name === ADD_TOOL.name) {
      try { const { summary } = await addToKept(params.arguments || {});
        return ok(id, { content: [{ type: "text", text: summary }] });
      } catch (e) { return ok(id, { content: [{ type: "text", text: `Could not add that: ${e.message}` }], isError: true }); }
    }
    if (params?.name === KEPT_TOOL.name) {
      try {
        const { trip, summary } = await readKept(params.arguments || {});
        return ok(id, { content: [{ type: "text",
          text: `${summary}\n\nThe trip as data:\n` + "```json\n" + JSON.stringify(trip, null, 2) + "\n```" }] });
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
                `asks for nothing; if they want it to last, keeping it starts at $2.50.` +
                longLinkNote(url),
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
  throws("says PARSE FAILURE when legs are a broken string, not 'needs a leg'", () =>
    buildLink({ origin: { lat: 1, lng: 1 }, legs: '[{"to":{"lat":1,"lng":1,"name":"Delicate" Arch"}}]' }), "not valid JSON");
  t("reads legs that arrived as a valid JSON string", () => {
    const { legs } = buildLink({ origin: { lat: 1, lng: 1 }, legs: '[{"to":{"lat":2,"lng":2}}]' });
    if (legs !== 1) throw new Error("leg count " + legs);
  });
  throws("names the leg that is not an object", () => buildLink({ origin: { lat: 1, lng: 1 }, legs: [{ to: { lat: 1, lng: 1 } }, "Moab"] }), "leg 2 is a string");
  t("amend appends, renames, removes and replaces", () => {
    const first = buildLink(trip).url;
    let r = amendLink({ link: first, add: [{ to: { name: "Moab, UT", lat: 38.57, lng: -109.55 } }], name: "Longer" });
    if (r.legs !== 3 || r.changed.added !== 1 || !r.changed.name) throw new Error(JSON.stringify(r.changed));
    r = amendLink({ link: r.url, remove: 1 });
    if (r.legs !== 2) throw new Error("remove left " + r.legs);
    r = amendLink({ link: r.url, legs: [{ to: { lat: 5, lng: 5 } }] });
    if (r.legs !== 1 || !r.changed.replaced) throw new Error("replace left " + r.legs);
  });
  throws("amend refuses a remove index off the end", () => amendLink({ link: buildLink(trip).url, remove: 9 }), "from 1 to 2");
  /* The network tools are async and can only REJECT, so their argument checks live in sync
     functions the harness can call: placeQuery() here, keptParts() + point() for add_to_kept —
     and keptParts' refusal of a #d= link is already asserted above. */
  throws("find_place refuses an empty query", () => placeQuery({ query: "  " }), "no place given");
  throws("find_place refuses a query longer than a place name", () => placeQuery({ query: "x".repeat(200) }), "longer than");
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
const inflight = new Set();
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
    /* handle() is async since read_kept_trip landed, so a throw arrives as a rejection and a
       plain try/catch here would let it escape as an unhandled rejection and kill the server.
       It is also TRACKED: see the "end" handler below for why that is not optional. */
    const job = Promise.resolve().then(() => handle(req))
      .catch((e) => err(req?.id ?? null, -32603, e.message));
    inflight.add(job);
    job.finally(() => inflight.delete(job));
  }
});
/* WAIT FOR IN-FLIGHT WORK BEFORE EXITING. `read_kept_trip` is the first tool that awaits
   anything, and a bare process.exit(0) here killed the process while its fetch was still open:
   a client that closes the pipe after writing one request — which is exactly how the tests and
   `printf | node` drive it — got an EMPTY REPLY and no error. Nothing logged, nothing threw; the
   answer simply never arrived. Two sync tools never exposed it. */
process.stdin.on("end", async () => {
  while (inflight.size) await Promise.allSettled([...inflight]);
  process.exit(0);
});
