process.on("warning", (w) => {
  if (w.code === "DEP0040") return;
});

import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { parsePhoneNumber } from "libphonenumber-js";
import os from "os";
import crypto from "crypto";

const CONVEX_URL = "https://tangible-tortoise-150.eu-west-1.convex.cloud";
const THREADS = parseInt(process.env.THREADS || "5");

const convex = new ConvexHttpClient(CONVEX_URL);

const nodeId = crypto
  .createHash("sha1")
  .update(os.hostname() + os.cpus()[0].model + Date.now() + Math.random())
  .digest("hex")
  .slice(0, 12);
const hostname = os.hostname();
const ip = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i.family === "IPv4" && !i.internal)?.address;

const useMobile = process.argv.includes("-phone");

const iPhone = {
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
};

const stats = { success: 0, failed: 0, existing: 0 };
let lastActivityAt = Date.now();

function generateStrongPassword() {
  return "Abuhider123@#$";
}

async function safeClose(obj) {
  if (!obj) return;
  try {
    await Promise.race([obj.close(), new Promise((r) => setTimeout(r, 5000))]);
  } catch {
    try {
      obj.process?.()?.kill("SIGKILL");
    } catch {}
  }
}

async function waitForApproval() {
  console.log(`[WORKER] Node ID: ${nodeId} | Host: ${hostname}`);
  console.log("[WORKER] Requesting approval from Telegram bot...");

  while (true) {
    const result = await convex.mutation(anyApi.nodes.requestApproval, {
      nodeId,
      hostname,
      ip,
    });

    if (result.status === "alive") {
      console.log("[WORKER] Node approved and active");
      return;
    }
    if (result.status === "requested" || result.status === "pending") {
      console.log("[WORKER] Waiting for admin approval...");
      await new Promise((r) => setTimeout(r, 10000));

      const check = await convex.query(anyApi.nodes.checkNode, { nodeId });
      if (check.valid) {
        console.log("[WORKER] Approved");
        return;
      }
      continue;
    }
    if (result.status === "expired") {
      console.log("[WORKER] Previous pass expired, requesting new approval...");
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    console.error("[WORKER] Unexpected status:", result.status);
    process.exit(1);
  }
}

async function checkPassValid() {
  const check = await convex.query(anyApi.nodes.checkNode, { nodeId });
  return check.valid;
}

async function processNumber(entry, threadIndex) {
  const { id: numberId, phone: rawPhone } = entry;
  const log = (status, msg) => {
    const sym =
      status === "success" ? "[+]" : status === "error" ? "[!]" : "[*]";
    console.log(`${sym} Thread ${threadIndex + 1}: ${rawPhone} -> ${msg}`);
  };

  const normalized = rawPhone.trim().replace(/[\.\s]/g, "");
  const withPlus = normalized.startsWith("+") ? normalized : `+${normalized}`;

  let phoneData;
  try {
    phoneData = parsePhoneNumber(withPlus);
  } catch {
    phoneData = null;
  }

  if (!phoneData) {
    log("error", "Invalid phone number format");
    stats.failed++;
    await convex.mutation(anyApi.numbers.reportResult, {
      nodeId,
      number_id: numberId,
      phone: rawPhone,
      status: "failed",
      error: "Invalid phone number format",
    });
    lastActivityAt = Date.now();
    return;
  }

  const countryCode = `+${phoneData.countryCallingCode}`;
  const nationalNumber = phoneData.nationalNumber;
  const password = generateStrongPassword();

  log("active", "Launching browser");

  let browser = null,
    context = null,
    page = null;

  try {
    browser = await Promise.race([
      chromium.launch({
        headless: false,
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Browser launch timeout")), 30000),
      ),
    ]);

    context = await browser.newContext(
      useMobile ? iPhone : { viewport: { width: 1280, height: 720 } },
    );
    page = await context.newPage();

    log("active", "Navigating to ChatGPT");
    await Promise.race([
      page.goto("https://chatgpt.com/"),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Navigation timeout")), 30000),
      ),
    ]);
    await page.waitForTimeout(2000);

    log("active", "Clicking Log in");
    await page.locator('button[data-testid="login-button"]').click();
    await page.waitForTimeout(1500);

    log("active", "Continue with phone");
    await page.getByText("Continue with phone").click();
    await page.waitForTimeout(1500);

    log("active", "Entering phone number");
    const phoneInput = page.locator("#phoneNumberInput");
    await phoneInput.waitFor({ state: "visible", timeout: 10000 });
    await phoneInput.fill(`${countryCode}${nationalNumber}`);
    await page.waitForTimeout(800);

    log("active", "Submitting");
    await page.locator('button[type="submit"]').click();

    await Promise.race([
      page.waitForURL("**/password", { timeout: 15000 }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Password page timeout")), 15000),
      ),
    ]);

    if (page.url().includes("/log-in/password")) {
      log("error", "Account already exists");
      stats.existing++;
      await convex.mutation(anyApi.numbers.reportResult, {
        nodeId,
        number_id: numberId,
        phone: rawPhone,
        status: "existing",
      });
      return;
    }

    log("active", "Entering password");
    await page.locator('input[type="password"]').first().fill(password);
    await page.waitForTimeout(800);

    log("active", "Submitting password");
    await page.locator('button[type="submit"]').click();

    await Promise.race([
      page.waitForURL("**/contact-verification", { timeout: 15000 }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Verification page timeout")), 15000),
      ),
    ]);

    log("success", "Verification page reached");
    stats.success++;
    await convex.mutation(anyApi.numbers.reportResult, {
      nodeId,
      number_id: numberId,
      phone: rawPhone,
      status: "success",
    });
  } catch (err) {
    if (err.message.includes("Executable doesn't exist")) {
      console.error(
        "[WORKER] Playwright browser not installed. Run: npx playwright install chromium",
      );
      process.exit(1);
    }
    log("error", err.message.substring(0, 60));
    stats.failed++;
    await convex.mutation(anyApi.numbers.reportResult, {
      nodeId,
      number_id: numberId,
      phone: rawPhone,
      status: "failed",
      error: err.message,
    });
  } finally {
    lastActivityAt = Date.now();
    await safeClose(page);
    await safeClose(context);
    await safeClose(browser);
  }
}

async function checkBrowserInstalled() {
  console.log("[WORKER] Checking Playwright browser...");
  try {
    await Promise.race([
      chromium.launch({ headless: true }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Browser check timeout")), 30000),
      ),
    ]);
    console.log("[WORKER] Browser ready");
    return true;
  } catch (err) {
    if (err.message.includes("Executable doesn't exist")) {
      console.error(
        "[WORKER] Playwright browser not installed. Run: npx playwright install chromium",
      );
      process.exit(1);
    }
    throw err;
  }
}

async function runWorker() {
  console.log("[WORKER] Starting...");

  await checkBrowserInstalled();
  await waitForApproval();

  const startTime = Date.now();
  let totalProcessed = 0;

  const PING_INTERVAL = 2 * 60 * 1000;
  const ACTIVITY_TTL = 4 * 60 * 1000;
  setInterval(async () => {
    if (Date.now() - lastActivityAt < ACTIVITY_TTL) return;
    try {
      await convex.mutation(anyApi.nodes.ping, { nodeId });
      lastActivityAt = Date.now();
    } catch {}
  }, PING_INTERVAL);

  while (true) {
    const valid = await checkPassValid();
    if (!valid) {
      console.log("[WORKER] Pass expired, requesting new approval...");
      await waitForApproval();
      continue;
    }

    const claims = [];
    for (let i = 0; i < THREADS; i++) {
      const entry = await convex.mutation(anyApi.numbers.claimNumber, {
        nodeId,
      });
      if (entry) claims.push(entry);
    }
    lastActivityAt = Date.now();

    if (claims.length === 0) {
      const { available } = await convex.query(anyApi.numbers.poolStatus, {
        nodeId,
      });
      console.log(`[WORKER] Pool empty (${available} available), retrying...`);
      continue;
    }

    console.log(`[WORKER] Claimed ${claims.length} numbers, processing...`);
    await Promise.all(claims.map((entry, i) => processNumber(entry, i)));

    totalProcessed += claims.length;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    console.log(
      `[WORKER] Batch done | Total: ${totalProcessed} | Success: ${stats.success} | Existing: ${stats.existing} | Failed: ${stats.failed} | Elapsed: ${elapsed}s`,
    );
  }
}

runWorker().catch((err) => {
  console.error("[WORKER] Fatal:", err.message);
  process.exit(1);
});
