const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

const $soLocal = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
let $soCache = { at: 0, keys: new Set(), proxies: [], strategy: {} };
let $soRR = -1;
function $soState() {
  if (Date.now() - $soCache.at < 30000) return $soCache;
  const { DatabaseSync } = require("node:sqlite");
  const dir = process.env.DATA_DIR || path.join(require("os").homedir(), ".9router");
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"), { readOnly: true });
  try {
    const keys = new Set(db.prepare("select key from apiKeys where isActive = 1").all().map((r) => r.key));
    const proxies = db.prepare("select id, data from proxyPools where isActive = 1").all()
      .map((r) => ({ id: r.id, ...JSON.parse(r.data || "{}") }))
      .filter((p) => p.proxyUrl);
    const settings = JSON.parse(db.prepare("select data from settings limit 1").get()?.data || "{}");
    const strategy = settings.providerStrategies?.opencode || {};
    $soCache = { at: Date.now(), keys, proxies, strategy };
  } finally {
    db.close();
  }
  return $soCache;
}
// Mesma regra do 9router para provider noAuth: rotateStrategy sobre os proxyPools ativos,
// senão o proxyPoolId fixo, senão saída direta.
function $soPickProxy(st) {
  const rot = st.strategy.rotateStrategy || "none";
  if (rot === "round-robin" && st.proxies.length) return st.proxies[($soRR = ($soRR + 1) % st.proxies.length)];
  if (rot === "random" && st.proxies.length) return st.proxies[Math.floor(Math.random() * st.proxies.length)];
  if (st.strategy.proxyPoolId) return st.proxies.find((p) => p.id === st.strategy.proxyPoolId) || null;
  return null;
}
// A imagem não tem undici: túnel HTTP CONNECT + TLS com o core do Node.
function $soPost(proxy, payload) {
  const https = require("https");
  const tls = require("tls");
  return new Promise((resolve, reject) => {
    const go = (createConnection) => {
      const r = https.request({
        host: "opencode.ai", port: 443, path: "/zen/v1/systemone", method: "POST", timeout: 120000,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: "Bearer public" },
        // Sem `agent`: com agent:false o Node cria um Agent próprio e ignora o createConnection,
        // e a requisição sai direto (pelo IPv4 de casa, por causa do --dns-result-order=ipv4first).
        ...(createConnection ? { createConnection } : {}),
      }, (resp) => {
        const out = [];
        resp.on("data", (c) => out.push(c));
        resp.on("end", () => resolve({ status: resp.statusCode, type: resp.headers["content-type"], body: Buffer.concat(out) }));
        resp.on("error", reject);
      });
      r.on("timeout", () => r.destroy(new Error("upstream timeout")));
      r.on("error", reject);
      r.end(payload);
    };
    if (!proxy) return go(null);
    const u = new URL(proxy.proxyUrl);
    const auth = u.username
      ? { "proxy-authorization": "Basic " + Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password)).toString("base64") }
      : {};
    const c = http.request({
      host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || 80, method: "CONNECT", path: "opencode.ai:443",
      headers: { host: "opencode.ai:443", ...auth }, timeout: 15000,
    });
    c.on("connect", (resp, sock) => {
      if (resp.statusCode !== 200) {
        sock.destroy();
        return reject(new Error(`CONNECT ${resp.statusCode}`));
      }
      go(() => tls.connect({ socket: sock, servername: "opencode.ai" }));
    });
    c.on("timeout", () => c.destroy(new Error("proxy timeout")));
    c.on("error", reject);
    c.end();
  });
}
// Modelo de outro provider (openrouter/typesafe/jev-1.13, v1m/...) vai pro handler nativo do
// Next, que já sabe falar com eles; aqui só o Zen precisa da saída pelos proxies.
function $soNative(req, res, buf) {
  const headers = { "content-type": "application/json", "content-length": buf.length };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  const r = http.request({ host: "127.0.0.1", port: process.env.PORT || 20128, path: "/api/v1/systemone", method: "POST", headers }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  r.on("error", (e) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "systemone nativo: " + e.message } }));
  });
  r.end(buf);
}
function $systemone(req, res, ip) {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  let st;
  try {
    st = $soState();
  } catch (e) {
    return send(500, { error: { message: "9router db read failed: " + e.message } });
  }
  if (!$soLocal.has(ip)) {
    const key = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!st.keys.has(key)) return send(401, { error: { message: "Invalid API key" } });
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, { error: { message: "invalid JSON body" } });
    }
    const model = String(body.model || "jev-1.13-free");
    if (model.includes("/") && !/^(oc|opencode)\//.test(model)) return $soNative(req, res, Buffer.concat(chunks));
    body.model = model.replace(/^(oc|opencode)\//, "");
    const payload = JSON.stringify(body);
    let erro;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const proxy = $soPickProxy(st);
      const t0 = Date.now();
      try {
        const r = await $soPost(proxy, payload);
        console.log(`[systemone] ${body.model} ${r.status} ${Date.now() - t0}ms ip=${ip} via=${proxy ? proxy.name : "direto"}`);
        res.writeHead(r.status, { "content-type": r.type || "application/json" });
        return res.end(r.body);
      } catch (e) {
        erro = `${proxy ? proxy.name : "direto"}: ${e.message}`;
        console.log(`[systemone] falha ${erro}`);
      }
    }
    send(502, { error: { message: "upstream systemone: " + erro } });
  });
}

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    if (req.method === "POST" && /^\/v1\/(systemone|decisions)\/?(\?|$)/.test(req.url || "")) return $systemone(req, res, ip);
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
