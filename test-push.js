const http2 = require("http2");
const crypto = require("crypto");
const fs = require("fs");

const envContent = fs.readFileSync(".env", "utf-8");

const env = {};
let currentKey = null;
let currentValue = "";
for (const line of envContent.split("\n")) {
  if (line.startsWith("#") || line.trim() === "") continue;
  if (currentKey) {
    currentValue += "\n" + line;
    if (line.includes("END PRIVATE KEY")) {
      env[currentKey] = currentValue;
      currentKey = null;
      currentValue = "";
    }
    continue;
  }
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const k = line.substring(0, eq);
  const v = line.substring(eq + 1);
  if (v.includes("BEGIN PRIVATE KEY") && v.indexOf("END PRIVATE KEY") === -1) {
    currentKey = k;
    currentValue = v;
  } else {
    env[k] = v;
  }
}

console.log("Key ID:", env.APNS_KEY_ID);
console.log("Team ID:", env.APNS_TEAM_ID);
console.log("Bundle ID:", env.APNS_BUNDLE_ID);

const rawKey = env.APNS_KEY.replace(/^"|"$/g, '');
const p8Key = rawKey.replace(/\\n/g, '\n');

function base64url(input) {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const header = { alg: "ES256", kid: env.APNS_KEY_ID };
const payload = { iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) };
const signingInput = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(payload));
const sign = crypto.createSign("SHA256");
sign.update(signingInput);
const jwt = signingInput + "." + base64url(sign.sign(p8Key));

const deviceToken = process.argv[2] || "3696323e3aba4b568ccdf9ea2a5562ef90c528a23f1c7a7e2fdcec59874fb927";
const message = process.argv[3] || "新Key推送测试！";

const session = http2.connect("https://api.sandbox.push.apple.com");
const req = session.request({
  ":method": "POST",
  ":path": `/3/device/${deviceToken}`,
  authorization: `bearer ${jwt}`,
  "apns-topic": env.APNS_BUNDLE_ID,
  "apns-push-type": "alert",
  "apns-priority": "10",
  "content-type": "application/json",
});

let statusCode = 0, responseData = "";
req.on("response", (h) => { statusCode = h[":status"]; });
req.on("data", (c) => { responseData += c; });
req.on("end", () => {
  console.log("Status:", statusCode);
  if (responseData) console.log("Response:", responseData);
  session.close();
});
req.end(JSON.stringify({ aps: { alert: { title: "CodeCrab", body: message }, sound: "default" } }));
