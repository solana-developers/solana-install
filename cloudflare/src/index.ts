import { Hono } from "hono";

// Interface for the Cloudflare environment bindings
interface CloudflareBindings {
  INSTALL_COUNTERS: KVNamespace;
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

const SOLANA_INSTALL_URL =
  "https://raw.githubusercontent.com/solana-developers/solana-install/main/install.sh";

// Counter keys
const TOTAL_REQUESTS_KEY = "total_requests";
const DAILY_KEY_PREFIX = "daily";
const WEEKLY_KEY_PREFIX = "weekly";
const MONTHLY_KEY_PREFIX = "monthly";

/**
 * Generate time-based keys for the current time periods
 */
function getTimeBasedKeys(): {
  daily: string;
  weekly: string;
  monthly: string;
} {
  const now = new Date();

  // Format: daily_YYYY-MM-DD (e.g., daily_2025-03-10)
  const dailyKey = `${DAILY_KEY_PREFIX}_${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  // Get week number for weekly key
  const weekNumber = getWeekNumber(now);
  // Format: weekly_YYYY-WW (e.g., weekly_2025-10)
  const weeklyKey = `${WEEKLY_KEY_PREFIX}_${now.getFullYear()}-${String(
    weekNumber
  ).padStart(2, "0")}`;

  // Format: monthly_YYYY-MM (e.g., monthly_2025-03)
  const monthlyKey = `${MONTHLY_KEY_PREFIX}_${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;

  return { daily: dailyKey, weekly: weeklyKey, monthly: monthlyKey };
}

/**
 * Get ISO week number
 */
function getWeekNumber(date: Date): number {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Increment all time-based counters at once
 */
async function incrementAllCounters(kv: KVNamespace): Promise<void> {
  try {
    const { daily, weekly, monthly } = getTimeBasedKeys();

    // Increment all counters in parallel
    await Promise.all([
      incrementCounter(kv, TOTAL_REQUESTS_KEY),
      incrementCounter(kv, daily),
      incrementCounter(kv, weekly),
      incrementCounter(kv, monthly),
    ]);
  } catch (error) {
    console.error("Failed to increment counters:", error);
  }
}

// Endpoint to get stats
app.get("/stats", async (c) => {
  try {
    // Get current time period keys
    const { daily, weekly, monthly } = getTimeBasedKeys();

    // Get all counts in parallel
    const [totalRequests, dailyCount, weeklyCount, monthlyCount] =
      await Promise.all([
        c.env.INSTALL_COUNTERS.get(TOTAL_REQUESTS_KEY, "text").then((val) =>
          Number(val || 0)
        ),
        c.env.INSTALL_COUNTERS.get(daily, "text").then((val) =>
          Number(val || 0)
        ),
        c.env.INSTALL_COUNTERS.get(weekly, "text").then((val) =>
          Number(val || 0)
        ),
        c.env.INSTALL_COUNTERS.get(monthly, "text").then((val) =>
          Number(val || 0)
        ),
      ]);

    // Return stats with time period information
    return c.json({
      totalRequests,
      today: dailyCount,
      thisWeek: weeklyCount,
      thisMonth: monthlyCount,
      periods: {
        day: daily.split("_")[1],
        week: weekly.split("_")[1],
        month: monthly.split("_")[1],
      },
    });
  } catch (error) {
    return c.json({ error: "Failed to retrieve stats" }, 500);
  }
});

// Helper function to increment a counter
async function incrementCounter(kv: KVNamespace, key: string): Promise<void> {
  try {
    // Get current value
    const currentVal = await kv.get(key, "text");
    const newVal = (Number(currentVal || 0) + 1).toString();

    // Set new value
    await kv.put(key, newVal);
  } catch (error) {
    console.error(`Failed to increment counter ${key}:`, error);
  }
}

app.get("/", async (c) => {
  console.log(`[${new Date().toISOString()}]`);
  // Increment all time-based counters
  c.executionCtx.waitUntil(incrementAllCounters(c.env.INSTALL_COUNTERS));

  try {
    // Fetch the install script from GitHub
    const response = await fetch(SOLANA_INSTALL_URL, {
      cf: {
        // Force Cloudflare to cache this response
        cacheTtl: 3600, // Cache for 1 hour
        cacheEverything: true,
      },
    });

    if (!response.ok) {
      console.error(
        `[${new Date().toISOString()}] Failed to fetch: ${response.status} ${
          response.statusText
        }`
      );

      throw new Error(
        `Failed to fetch install script: ${response.status} ${response.statusText}`
      );
    }

    // Get the script content
    const scriptContent = await response.text();

    // Return the script with appropriate content type and cache headers
    return new Response(scriptContent, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    // Type assertion for the error
    const err = error as Error;
    console.error(
      `[${new Date().toISOString()}] Error serving install script:`,
      err
    );

    return new Response("Error fetching Solana install script", {
      status: 500,
    });
  }
});

export default app;
