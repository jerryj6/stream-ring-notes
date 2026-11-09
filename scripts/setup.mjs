import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const project = fileURLToPath(new URL("../", import.meta.url));
const envFile = join(project, ".env");
const args = new Set(process.argv.slice(2));
const docker = args.has("--docker");
const { stdin, stdout } = process;
const cancelled = Symbol("setup cancelled");
const color = stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
// Compact version of the Sandbar console logo.
const sandbarLogo = [
  "                         @@@@@@@@@@",
  "                      @@@@@@@@@@@@@@@",
  "                    @@@@@@@@@@@@@@@@@@@",
  "                   @@@@@@@@@@@   @@@@@@",
  "@@               @@@@@@@@@@        @@@@@",
  "@@@            @@@@@@@@@@            @@@",
  "@@@@@        @@@@@@@@@@              @@@",
  " @@@@@@   @@@@@@@@@@@",
  " @@@@@@@@@@@@@@@@@@@",
  "   @@@@@@@@@@@@@@@",
  "     @@@@@@@@@@",
];

function style(code, text) {
  return color ? "\x1b[" + code + "m" + text + "\x1b[0m" : text;
}

async function initialize() {
  const template = await readFile(join(project, ".env.example"), "utf8");
  const key = randomBytes(32).toString("hex");
  try {
    await writeFile(envFile, template.replace(/^API_KEY=$/m, "API_KEY=" + key), { mode: 0o600, flag: "wx" });
    console.log("Created .env and generated an operator key.");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    console.log("Using the existing .env.");
  }
}

async function save(key, value) {
  const contents = await readFile(envFile, "utf8");
  const entry = key + "=" + value;
  const assignment = new RegExp("^[ \\t]*(?:export[ \\t]+)?" + key + "[ \\t]*[:=].*$", "gm");
  const next = assignment.test(contents)
    ? contents.replace(assignment, () => entry)
    : contents.trimEnd() + "\n" + entry + "\n";

  const temporary = await mkdtemp(join(project, ".env.setup-"));
  try {
    const file = join(temporary, "config");
    await writeFile(file, next, { mode: 0o600 });
    await rename(file, envFile);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function ask(prompt, hidden = false) {
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : stdout;
  const rl = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  if (hidden) stdout.write(prompt);
  try {
    const answer = await Promise.race([rl.question(hidden ? "" : prompt), once(rl, "close").then(() => cancelled)]);
    if (answer === cancelled) throw cancelled;
    return answer.trim();
  } finally {
    rl.close();
    if (hidden) stdout.write("\n");
  }
}

async function npm(...command) {
  const npmPath = process.env.npm_execpath;
  const child = npmPath
    ? spawn(process.execPath, [npmPath, "run", ...command], { cwd: project, stdio: "inherit" })
    : spawn("npm", ["run", ...command], { cwd: project, stdio: "inherit" });
  const [code] = await once(child, "exit");
  return code === 0;
}

async function configureStream() {
  console.log("On your iPhone, open Stream → Settings → Other Tools → Developer (Webhook).");
  console.log("Set the HTTPS URL ending in /stream/ig and turn on Sign requests.");
  const secret = await ask("Paste the full swh_ signing secret (input hidden, Enter to keep): ", true);
  if (!secret) return;
  if (!/^swh_[A-Za-z0-9_+/=-]+$/.test(secret)) {
    console.log("Use the full signing secret beginning with swh_.");
    return;
  }
  await save("STREAM_WEBHOOK_SECRET", secret);
  console.log("Saved the Stream signing secret.");
}

async function configurePosting() {
  const audience = await ask("Audience (0 = followers you follow back, 1 = Close Friends, Enter to keep): ");
  if (audience === "0" || audience === "1") await save("DEFAULT_AUDIENCE", audience);
  else if (audience) {
    console.log("Choose 0 or 1.");
    return;
  }

  console.log("Instagram's private API is experimental. Instagram can challenge or restrict accounts.");
  const setting = await ask("Type ENABLE to allow posting, DISABLE to turn it off, or Enter to keep: ");
  if (setting === "ENABLE" || setting === "DISABLE") {
    await save("ENABLE_PRIVATE_API", setting === "ENABLE" ? "true" : "false");
    console.log("Saved the posting setting.");
  } else if (setting) {
    console.log("Posting setting kept.");
  }
}

async function login(exportSession) {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log("No desktop display found. Open setup on your own computer to sign in and export a session.");
    return;
  }
  console.log("Run this on a computer with a screen. Stop any bridge using this profile first.");
  if (!await npm("install-browser")) return;
  if (!await npm("login", ...(exportSession ? ["--", "--export"] : []))) return;
  if (exportSession) console.log("Use the remote sign-in section in README.md to import the session over SSH.");
}

async function checks() {
  const url = await ask("Public HTTPS webhook URL (Enter to check the local listener): ");
  await npm("check-stream", ...(url ? ["--", url] : []));
  await npm("status", "--", "--check-instagram");
}

async function header() {
  const env = parseEnv(await readFile(envFile, "utf8"));
  const details = [
    style("1", "Stream Ring Notes"),
    style("2", docker ? "Setup / Docker host" : "Setup / This computer"),
    "",
    "Stream    " + (env.STREAM_WEBHOOK_SECRET ? style("32", "Signing secret set") : "Signing secret missing"),
    "Posting   " + (env.ENABLE_PRIVATE_API === "true" ? style("33", "Enabled") : "Off"),
    "Audience  " + (env.DEFAULT_AUDIENCE === "1" ? "Close Friends" : "Followers you follow back"),
  ];
  console.log();
  if (stdout.columns && stdout.columns < 80) {
    console.log(details.join("\n"));
  } else {
    for (const [index, line] of sandbarLogo.entries()) {
      const art = style("36", line.padEnd(40));
      console.log(art + "  " + (details[index] ?? ""));
    }
  }
  console.log();
}

function choose(actions) {
  const options = [...actions, ["0", ["Exit"]]];
  let selected = 0;
  const width = (stdout.columns || 80) - 1;

  function render(redraw = false) {
    if (redraw) {
      stdout.moveCursor(0, -options.length);
      stdout.cursorTo(0);
    }
    for (const [index, [key, [label]]] of options.entries()) {
      if (redraw) stdout.clearLine(0);
      const line = ((index === selected ? "› " : "  ") + key + "  " + label).slice(0, width);
      console.log(index === selected ? style("1;36", line) : line);
    }
  }
  emitKeypressEvents(stdin);

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    function finish(choice) {
      stdin.off("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      console.log();
      resolve(choice);
    }
    function onKey(text, key = {}) {
      if (text === "q" || (key.ctrl && key.name === "c")) return finish("0");
      if (key.name === "return" || key.name === "enter") return finish(options[selected][0]);
      const shortcut = options.findIndex(([number]) => number === text);
      const offset = key.name === "down" ? 1 : key.name === "up" ? -1 : 0;
      const next = shortcut >= 0 ? shortcut : (selected + offset + options.length) % options.length;
      if (next === selected) return;
      selected = next;
      render(true);
    }
    stdin.setRawMode(true);
    stdin.on("keypress", onKey);
    console.log(style("2", "↑ ↓ move   ·   Enter select   ·   number jump   ·   q quit"));
    render();
    stdin.resume();
  });
}

async function menu() {
  const actions = new Map([
    ["1", ["Connect Stream webhook", configureStream]],
    ["2", ["Choose the Note audience or enable/disable posting", configurePosting]],
  ]);
  if (!docker) {
    actions.set("3", ["Sign in to Instagram on this computer", () => login(false)]);
    actions.set("4", ["Sign in and export a session for a remote server", () => login(true)]);
    actions.set("5", ["Build and run the bridge", async () => {
      if (!await npm("build")) return;
      console.log("Bridge running in this terminal. Press Ctrl+C to stop it.");
      await npm("start");
    }]);
    actions.set("6", ["Check the running Stream and Instagram connections", checks]);
  }

  while (true) {
    await header();
    const selection = await choose(actions);
    if (selection === "0") return;
    await actions.get(selection)[1]();
    if (selection === "1" || selection === "2") {
      console.log(docker
        ? "Apply .env changes with docker compose -f deploy/docker-compose.yml up -d --wait --force-recreate."
        : "Restart the bridge to apply .env changes.");
    }
  }
}

try {
  await initialize();
  if (!args.has("--init") && stdin.isTTY && stdout.isTTY) await menu();
} catch (err) {
  if (err !== cancelled) {
    console.error("Setup failed:", err.message);
    process.exitCode = 1;
  }
}
