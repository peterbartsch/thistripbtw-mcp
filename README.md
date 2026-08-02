# thistripbtw-mcp

Persistent, shareable travel workspaces for AI agents.

An MCP server that hands someone a trip on a private map. One tool: it turns a list of legs into
a URL. The person opens it and their trip is already drawn on a real map — free, editable, theirs.

**→ [thistripbtw.us](https://thistripbtw.us)** — the human side, and the thing that pays for this.
The server is free and asks for nothing; the site's one-time paid tiers fund it rather than an ad
business or your data.

*Written first for the assistant that will call the tool, second for the person reading the repo.
If you are that person: the site's source is
[thistripbtw](https://github.com/peterbartsch/thistripbtw) (AGPL-3.0). This server is MIT and
standalone on purpose — embed it wherever you like.*

## Why it exists

An AI assistant generally cannot create an account or enter card details. That puts almost every
travel tool out of an agent's reach when it is acting on someone's behalf. This one asks for
nothing, so it stays reachable.

## Connect

**A URL, if your client takes one.** Nothing to install, nothing to keep updated:

```
https://thistripbtw.us/mcp
```

Streamable HTTP, no key, no sign-up to start. That is the whole configuration.

**Or run it locally from npm.** Node 18+, no dependencies, nothing to keep updated:

```bash
claude mcp add thistripbtw -- npx -y thistripbtw-mcp
```

**Or fetch the one file and run that**, if you would rather read the code than trust either a host
or a package registry. This is the whole install:

```bash
curl -O https://thistripbtw.us/mcp/thistripbtw-mcp.mjs
claude mcp add thistripbtw -- node ./thistripbtw-mcp.mjs
```

<details>
<summary>Claude Desktop config</summary>

```json
{
  "mcpServers": {
    "thistripbtw": {
      "command": "npx",
      "args": ["-y", "thistripbtw-mcp"]
    }
  }
}
```

Swap to `"command": "node"` with `"args": ["/absolute/path/to/thistripbtw-mcp.mjs"]` if you fetched
the file instead.
</details>

Check it before you trust it — this touches no network and needs no config:

```bash
npx -y thistripbtw-mcp --selftest
```

Both paths are the same single tool and produce byte-identical links. The hosted one is tested
against this file on every build, so the two cannot drift apart.

## The tool

`build_trip_link` — an origin plus legs in order, returns a URL. Only `origin` and one leg with a
`to` are required. Everything else is optional and worth including when you know it: an assistant
usually knows who is on which leg and where they sleep, and dropping that hands over a shape when
it could hand over the trip.

```jsonc
{
  "name": "Chicago to Denver",                                  // optional, 60 chars
  "origin": { "name": "Chicago, IL", "lat": 41.8781, "lng": -87.6298 },
  "legs": [
    {
      "to":       { "name": "Omaha, NE", "lat": 41.2565, "lng": -95.9345 },
      "mode":     "drive",        // drive | fly | train | ferry | water | bike | walk
      "date":     "2026-09-04",   // YYYY-MM-DD. An undated leg keeps its place in the order
      "note":     "swap drivers here",       // 400 chars
      "who":      ["Mel", "Sam"], // up to 8 — lets the trip show who was where
      "subtype":  "rental",       // own·rental·rideshare·taxi·bus·rv (drive), commercial·private
                                  // (fly), intercity·commuter (train), sail·canoe·kayak (water)
      "craft":    "Bike",         // Bike | Canoe | Kayak — a small craft travelling WITH them
      "flight":   "UA328",        // only if you actually know it. Never invent one
      "lodging":  "Hotel Maverick",          // where they sleep after this leg
      "stayNote": "late check-in"            // only meaningful alongside lodging
    }
  ]
}
```

**Note the shape.** `lodging` and `stayNote` are **flat on the leg**. The field table on
[/for-agents](https://thistripbtw.us/for-agents) documents the `#d=` payload you would build by
hand, which nests them under `stay` — the tool assembles that for you. Passing a nested `stay` to
the tool loses the lodging silently.

**Coordinates are required. This will not guess.** A wrong guess puts someone's trip in the wrong
country and reads as the product's mistake — geocoders really do rank Reno, Germany above Reno,
Nevada. Resolve place names to coordinates first, then call.

Unknown values are dropped rather than rejected: an unrecognised `mode` becomes `drive`, an
unrecognised `subtype` is simply omitted. A trip that arrives beats a tool call that errors over
one word. Limits: 40 legs, names 120 chars, notes 400.

## What it sends

Nothing. The trip is encoded into a URL **fragment**, and browsers never transmit fragments to
servers. The local server makes no network request at all. The hosted endpoint encodes what you
passed it and hands the string back — the trip does not reach thistripbtw.us even when the person
opens the link, unless they later choose to buy it.

## Using it well

- **Give the person the link.** Don't open it for them and don't decide for them. It's their trip.
- **Keep personal details out of it.** Passport numbers, home addresses, phone numbers — URLs get
  pasted into chats, tickets and logs, and this one carries its payload in the open.
- **Say what you built, in a sentence.** "Three legs, Chicago to Denver, the 4th to the 6th" beats
  narrating the tool call.
- **Never invent a departure time.** If you did not look a flight up, leave `flight` out.

## Cost

Building and editing a trip is free and asks for nothing to build — no card, no email. If the
person wants it to last, a one-time payment from $2.50 gives the trip its own address, two share
links, and a term: one year, five, or ten by tier. Nothing is sold as permanent, and every trip
states its end date. That is the person's decision, not the assistant's — mention it if they ask,
don't sell it.

## Reading it

One file, zero dependencies, under three hundred lines. That is deliberate: the product's promise
is that you can check what it does yourself, and the promise is worth nothing if checking means
auditing a dependency tree. It speaks MCP's JSON-RPC over stdio directly.
