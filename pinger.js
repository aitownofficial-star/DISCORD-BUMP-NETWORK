const https = require("https");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "pinger.json");

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const intervalMinutes = Number(config.intervalMinutes);
    const targetUrl = new URL(config.url);

    if (!config.enabled) {
      console.log("[DIF Pinger] 자동 핑이 비활성화되어 있습니다.");
      return null;
    }
    if (targetUrl.protocol !== "https:") {
      throw new Error("핑 주소는 HTTPS여야 합니다.");
    }
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      throw new Error("intervalMinutes는 0보다 큰 숫자여야 합니다.");
    }

    return { targetUrl, intervalMs: intervalMinutes * 60 * 1000 };
  } catch (error) {
    console.error("[DIF Pinger] pinger.json 설정 오류:", error.message);
    return null;
  }
}

const config = loadConfig();

function ping() {
  if (!config) return;

  const start = Date.now();
  const request = https.get(config.targetUrl, (response) => {
    response.resume();
    const elapsed = Date.now() - start;

    console.log(
      `[${new Date().toISOString()}] 🏓 DIF Render 핑 완료 | HTTP ${response.statusCode} | ${elapsed}ms`
    );
  });

  request.setTimeout(30000, () => {
    request.destroy(new Error("요청 시간 초과"));
  });

  request.on("error", (error) => {
    console.error(
      `[${new Date().toISOString()}] ❌ DIF Render 핑 실패 | ${error.message}`
    );
  });
}

if (config) {
  ping();
  setInterval(ping, config.intervalMs);
  console.log(`[DIF Pinger] ${config.intervalMs / 60000}분 간격으로 핑을 실행합니다.`);
}
