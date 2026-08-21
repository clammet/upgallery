import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const help = `Usage: pnpm profile:analyze -- <chrome-trace.json>

Summarise a Chrome trace recorded by pnpm profile:chrome without loading it
into DevTools: main-thread busy time per second, what the JavaScript callbacks
were, how many React components rendered (dev builds only), network requests,
and the hottest functions from the embedded CPU profile.`;

const file = process.argv.slice(2).find((argument) => argument !== "--");
if (file === undefined || file === "--help" || file === "-h") {
  console.log(help);
  process.exit(file === undefined ? 1 : 0);
}

const threadNames = new Map();
const threadBusy = new Map();
const perSecond = new Map();
const functionCalls = new Map();
const eventTotals = new Map();
const componentRenders = new Map();
const requests = new Map();
const profiles = new Map();
let eventCount = 0;
let firstTimestamp = Number.POSITIVE_INFINITY;
let lastTimestamp = 0;

const add = (map, key, duration = 0) => {
  const current = map.get(key) ?? { count: 0, total: 0 };
  current.count += 1;
  current.total += duration;
  map.set(key, current);
};

const reader = createInterface({
  input: createReadStream(file),
  crlfDelay: Number.POSITIVE_INFINITY,
});
for await (const rawLine of reader) {
  let line = rawLine.trim();
  if (!line.startsWith("{")) continue;
  if (line.endsWith(",")) line = line.slice(0, -1);
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  eventCount += 1;
  const thread = `${event.pid}:${event.tid}`;
  if (event.ph === "M") {
    if (event.name === "thread_name") threadNames.set(thread, event.args.name);
    continue;
  }
  if (typeof event.ts === "number" && event.ts > 0) {
    firstTimestamp = Math.min(firstTimestamp, event.ts);
    lastTimestamp = Math.max(lastTimestamp, event.ts);
  }
  if (event.name === "Profile" || event.name === "ProfileChunk") {
    const key = `${thread}:${event.id}`;
    const profile = profiles.get(key) ?? {
      thread,
      nodes: new Map(),
      samples: [],
      deltas: [],
    };
    const cpuProfile = event.args?.data?.cpuProfile;
    for (const node of cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node);
    if (cpuProfile?.samples) profile.samples.push(...cpuProfile.samples);
    if (event.args?.data?.timeDeltas) {
      profile.deltas.push(...event.args.data.timeDeltas);
    }
    profiles.set(key, profile);
    continue;
  }
  if (event.ph !== "X") {
    if (event.cat === "blink.user_timing" && (event.ph === "b" || event.ph === "n")) {
      add(componentRenders, event.name.replace(/​/g, ""));
    }
    if (event.name === "UpdateLayer") {
      // Instant events: one per compositor layer per frame. A high count
      // means many separately animated elements (spinners, for example).
      const bucket = perSecond.get(`${thread}|${Math.floor(event.ts / 1e6)}`) ?? new Map();
      add(bucket, event.name);
      perSecond.set(`${thread}|${Math.floor(event.ts / 1e6)}`, bucket);
    }
    continue;
  }
  const duration = event.dur ?? 0;
  if (event.name === "RunTask") {
    threadBusy.set(thread, (threadBusy.get(thread) ?? 0) + duration);
  }
  add(eventTotals, `${thread}|${event.name}`, duration);
  const second = Math.floor(event.ts / 1e6);
  const bucket = perSecond.get(`${thread}|${second}`) ?? new Map();
  add(bucket, event.name, duration);
  perSecond.set(`${thread}|${second}`, bucket);
  if (event.name === "FunctionCall") {
    const data = event.args?.data ?? {};
    const url = (data.url ?? "").replace(/^.*\/\/[^/]+/, "");
    add(
      functionCalls,
      `${thread}|${data.functionName || "(anonymous)"} ${url}:${data.lineNumber}`,
      duration,
    );
  }
  if (event.name === "ResourceSendRequest") {
    const url = (event.args?.data?.url ?? "?")
      .replace(/\?.*$/, "")
      .replace(/[0-9a-f]{16,}/g, "<id>");
    add(requests, url);
  }
}

const mainThread = [...threadBusy.entries()]
  .filter(([thread]) => threadNames.get(thread) === "CrRendererMain")
  .sort((a, b) => b[1] - a[1])[0]?.[0];
const ms = (microseconds) => `${(microseconds / 1e3).toFixed(0)}ms`;

console.log(
  `${eventCount} events covering ${((lastTimestamp - firstTimestamp) / 1e6).toFixed(1)}s`,
);
if (mainThread === undefined) {
  console.log("No renderer main thread found in this trace.");
  process.exit(0);
}
console.log(`Renderer main thread: ${mainThread}`);

console.log("\n== Main thread: busiest trace events ==");
const mainEvents = [...eventTotals.entries()]
  .filter(([key]) => key.startsWith(`${mainThread}|`))
  .map(([key, value]) => [key.split("|")[1], value])
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 25);
for (const [name, value] of mainEvents) {
  console.log(
    `  ${name.padEnd(44)} ${String(value.count).padStart(8)}x ${ms(value.total).padStart(9)}`,
  );
}

console.log("\n== Main thread: JavaScript callbacks (FunctionCall) ==");
const calls = [...functionCalls.entries()]
  .filter(([key]) => key.startsWith(`${mainThread}|`))
  .map(([key, value]) => [key.split("|")[1], value])
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 20);
for (const [name, value] of calls) {
  console.log(
    `  ${String(value.count).padStart(7)}x ${ms(value.total).padStart(9)}  ${name}`,
  );
}

console.log(
  "\n== Main thread per second (busy = RunTask; renders = React dev component measures) ==",
);
const seconds = [...perSecond.keys()]
  .filter((key) => key.startsWith(`${mainThread}|`))
  .map((key) => Number(key.split("|")[1]))
  .sort((a, b) => a - b);
const base = seconds[0];
const renderNames = new Set(["Paint", "Layout", "UpdateLayoutTree", "PrePaint", "Commit"]);
for (const second of seconds) {
  const bucket = perSecond.get(`${mainThread}|${second}`);
  const busy = bucket.get("RunTask")?.total ?? 0;
  const script = bucket.get("FunctionCall")?.total ?? 0;
  const micro = bucket.get("RunMicrotasks")?.total ?? 0;
  const gc = (bucket.get("MinorGC")?.total ?? 0) + (bucket.get("MajorGC")?.total ?? 0);
  let render = 0;
  for (const name of renderNames) render += bucket.get(name)?.total ?? 0;
  const layers = bucket.get("UpdateLayer")?.count ?? 0;
  const uploads = bucket.get("XHRLoad")?.count ?? 0;
  console.log(
    `  t+${String(second - base).padStart(3)}s busy=${ms(busy).padStart(7)} script=${ms(script).padStart(7)} microtasks=${ms(micro).padStart(6)} layout/paint=${ms(render).padStart(6)} gc=${ms(gc).padStart(5)} layerUpdates=${String(layers).padStart(6)} xhrLoads=${uploads}`,
  );
}

if (componentRenders.size > 0) {
  console.log("\n== React component renders (dev build measures) ==");
  for (const [name, value] of [...componentRenders.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)) {
    console.log(`  ${String(value.count).padStart(8)}  ${name}`);
  }
}

console.log("\n== Requests ==");
for (const [url, value] of [...requests.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 12)) {
  console.log(`  ${String(value.count).padStart(6)}  ${url}`);
}

for (const profile of profiles.values()) {
  if (profile.samples.length === 0 || profile.thread.split(":")[0] !== mainThread.split(":")[0]) {
    continue;
  }
  const parents = new Map();
  for (const node of profile.nodes.values()) {
    for (const child of node.children ?? []) parents.set(child, node.id);
    if (node.parent !== undefined) parents.set(node.id, node.parent);
  }
  const label = (node) => {
    const frame = node.callFrame ?? {};
    const url = (frame.url ?? "").replace(/^.*\/\/[^/]+/, "");
    return `${frame.functionName || "(anonymous)"} ${url}:${frame.lineNumber ?? ""}`;
  };
  const selfTime = new Map();
  const inclusiveTime = new Map();
  let sampled = 0;
  let unresolved = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = profile.deltas[index] ?? 0;
    sampled += delta;
    const node = profile.nodes.get(profile.samples[index]);
    if (node === undefined) {
      unresolved += delta;
      continue;
    }
    selfTime.set(label(node), (selfTime.get(label(node)) ?? 0) + delta);
    const seen = new Set();
    let current = node.id;
    for (let depth = 0; current !== undefined && depth < 256; depth += 1) {
      const ancestor = profile.nodes.get(current);
      if (ancestor === undefined) break;
      const name = label(ancestor);
      if (!seen.has(name)) {
        seen.add(name);
        inclusiveTime.set(name, (inclusiveTime.get(name) ?? 0) + delta);
      }
      current = parents.get(current);
    }
  }
  console.log(
    `\n== CPU profile (${(sampled / 1e6).toFixed(1)}s sampled, ${((100 * unresolved) / Math.max(sampled, 1)).toFixed(0)}% unresolved) ==`,
  );
  if (unresolved > sampled / 2) {
    console.log(
      "  Most samples point at call-tree nodes that are missing from the trace: the buffer filled or wrapped. Shorten the capture.",
    );
  }
  const print = (title, map) => {
    console.log(`  -- ${title} --`);
    for (const [name, value] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`   ${ms(value).padStart(8)} ${((100 * value) / Math.max(sampled, 1)).toFixed(1).padStart(5)}%  ${name}`);
    }
  };
  print("self time", selfTime);
  print("inclusive time", inclusiveTime);
}
