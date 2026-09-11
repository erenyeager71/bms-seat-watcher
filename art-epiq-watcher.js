const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const { chromium } = require("playwright");
const sendTelegram = require("./telegram");

// ============================================================================
// CONFIGURATION: ART Cinemas EPIQ Screen Watcher
// ============================================================================
// Replace URL with the actual BookMyShow seat layout URL for ART Cinemas EPIQ Screen
const URL =
  "https://in.bookmyshow.com/movies/HYD/seat-layout/ET00513087/ACEV/20003/20260823";;;;;;;;

// Showtimes to monitor for ART Cinemas EPIQ Screen
const SHOW_TIMES = [
  "09:45 AM EPIQ",
  "01:00 PM EPIQ",
  "04:15 PM EPIQ",
  "07:30 PM EPIQ"
];

// Mapping if Playwright recorded button names differ from display names
const SHOW_BUTTON_NAMES = {
  "09:45 AM EPIQ": "09:45 AM",
  "01:00 PM EPIQ": "01:00 PM",
  "04:15 PM EPIQ": "04:15 PM",
  "07:30 PM EPIQ": "07:30 PM"
};

// Interval between scans (in milliseconds)
const CHECK_INTERVAL = 5000;

// Target row/seat filters (optional - set to watch all seats by default)
const TARGET_ROWS = null; // e.g. new Set(["H", "I", "J", "K", "L", "M", "N"]);
const MIN_SEAT = null;   // e.g. 10;
const MAX_SEAT = null;   // e.g. 35;

// ============================================================================
// STATE MANAGEMENT & HELPERS
// ============================================================================
let previousState = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function seatKey(row, seat) {
  return `${row}-${seat}`;
}

function timestamp() {
  return new Date().toLocaleTimeString();
}

/**
 * Filter logic to check if a seat should be monitored.
 * Defaults to true for all seats. Modify TARGET_ROWS, MIN_SEAT, MAX_SEAT above to filter.
 */
function isTargetSeat(seat) {
  if (!TARGET_ROWS && MIN_SEAT === null && MAX_SEAT === null) {
    return true;
  }

  const row = seat.rowNumber;
  const number = Number(seat.displaySeatNumber);

  const rowMatches = !TARGET_ROWS || TARGET_ROWS.has(row);
  const minMatches = MIN_SEAT === null || number >= MIN_SEAT;
  const maxMatches = MAX_SEAT === null || number <= MAX_SEAT;

  return rowMatches && minMatches && maxMatches;
}

function buildState(seats) {
  const map = new Map();

  for (const seat of seats) {
    if (!isTargetSeat(seat)) continue;

    map.set(
      seatKey(seat.rowNumber, seat.displaySeatNumber),
      seat.seatStatus
    );
  }

  return map;
}

// ============================================================================
// PLAYWRIGHT & KONVA INTERACTION
// ============================================================================
async function waitForKonva(page) {
  try {
    await page.waitForFunction(
      () => {
        return (
          window.Konva &&
          window.Konva.stages &&
          window.Konva.stages.length > 0
        );
      },
      { timeout: 15000 }
    );
  } catch (err) {
    if (URL.includes("ET00XXXXXX")) {
      console.error(
        "\n❌ ERROR: URL contains placeholder 'ET00XXXXXX'. Please update line 11 in art-epiq-watcher.js with the real BookMyShow seat layout URL!\n"
      );
    } else {
      console.error(
        "\n⚠️ Konva canvas was not found on page within 15s. Check if seat layout page is active or URL is valid.\n"
      );
    }
    throw err;
  }
}

async function clickSelectSeats(page) {
  try {
    const btn = page.getByRole("button", { name: "Select Seats" });
    if (await btn.isVisible({ timeout: 5000 })) {
      await btn.click();
      console.log("Opened seat map");
      await page.waitForTimeout(1000);
      return;
    }
  } catch { }

  try {
    const textBtn = page.locator("text=Select Seats").first();
    if (await textBtn.isVisible({ timeout: 2000 })) {
      await textBtn.click({ force: true });
      console.log("Opened seat map (text fallback)");
      await page.waitForTimeout(1000);
    }
  } catch { }
}

async function selectShow(page, showName) {
  try {
    const buttonName = SHOW_BUTTON_NAMES[showName] || showName;
    const target = page.locator(`text=${buttonName}`).first();

    if (await target.isVisible({ timeout: 3000 })) {
      await target.click({ force: true });
      console.log(`Selected show: ${showName}`);
      await page.waitForTimeout(2000);
    }
  } catch (err) {
    console.error(`Could not select ${showName}:`, err.message);
  }
}

async function extractSeats(page) {
  return await page.evaluate(() => {
    function walk(node, list) {
      if (!node) return;

      if (node.attrs && node.attrs.seatObj) {
        list.push(node.attrs.seatObj);
      }

      if (node.children) {
        for (const child of node.children) {
          walk(child, list);
        }
      }
    }

    const seats = [];
    if (!window.Konva) return seats;

    for (const stage of window.Konva.stages) {
      walk(stage, seats);
    }

    return seats;
  });
}

async function createBrowserPage() {
  const browser = await chromium.launch({
    headless: false
  });

  const page = await browser.newPage();

  await page.goto(URL, {
    waitUntil: "networkidle"
  });

  await clickSelectSeats(page);
  await waitForKonva(page);
  await page.waitForTimeout(3000);

  return { browser, page };
}

// ============================================================================
// SCANNING LOGIC
// ============================================================================
async function grabCurrentState(page, showName) {
  await clickSelectSeats(page);
  await selectShow(page, showName);
  await clickSelectSeats(page);
  await waitForKonva(page);
  await page.waitForTimeout(2000);

  const seats = await extractSeats(page);
  console.log(`Found ${seats.length} seats for ${showName} (ART Cinemas EPIQ)`);

  return buildState(seats);
}

async function checkSeats(page, showName) {
  console.log(`\n[${timestamp()}] Checking ${showName} (ART Cinemas EPIQ)...`);

  const currentState = await grabCurrentState(page, showName);
  const previousShowState = previousState.get(showName);

  if (!previousShowState || previousShowState.size === 0) {
    previousState.set(showName, currentState);
    console.log(`Initial state saved for ${showName}`);

    // Group available seats (status === 1) by row
    const rowCounts = new Map();
    let totalAvailable = 0;

    for (const [seat, status] of currentState) {
      if (status === 1) {
        totalAvailable++;
        const row = seat.split("-")[0] || "Unknown";
        rowCounts.set(row, (rowCounts.get(row) || 0) + 1);
      }
    }

    const availableRows = Array.from(rowCounts.keys());

    const rowDetails = availableRows.map(
      row => `• Row ${row}: ${rowCounts.get(row)} seats available`
    );

    const initMessage = [
      `📊 Initial Scan - Available Rows Overview`,
      "🎟 ART Cinemas - EPIQ Screen",
      `🕒 Show: ${showName}`,
      "",
      `Total Available Seats: ${totalAvailable}`,
      `Available Rows (${availableRows.length}): ${availableRows.join(", ")}`,
      "",
      "Row Breakdown:",
      ...(rowDetails.length > 0 ? rowDetails : ["No seats available"]),
      "",
      `🔗 ${URL}`,
      `🕒 ${timestamp()}`
    ].join("\n");

    console.log(
      `Sending initial scan row overview for ${showName} (${totalAvailable} available seats across ${availableRows.length} rows)...`
    );
    await sendTelegram(initMessage);
    return false;
  }

  const released = [];
  const taken = [];

  for (const [seat, status] of currentState) {
    const previous = previousShowState.get(seat);
    const wasAvailable = previous === 1;
    const isAvailable = status === 1;

    if (!wasAvailable && isAvailable) {
      released.push(seat);
    }

    if (wasAvailable && !isAvailable) {
      taken.push(seat);
    }
  }

  if (released.length > 0) {
    console.log(`Released seats for ${showName}:`, released);

    const message = [
      `🎟 Released: ${released.join(", ")}`,
      "🎉 Seats Released!",
      "🎟 ART Cinemas - EPIQ Screen",
      `🕒 Show: ${showName}`,
      "",
      "Released seats:",
      ...released.map(seat => `• ${seat}`),
      "",
      `🔗 ${URL}`,
      `🕒 ${timestamp()}`
    ].join("\n");

    await sendTelegram(message);
    previousState.set(showName, currentState);
    return true;
  } else {
    console.log(`No releases for ${showName}`);
  }

  if (taken.length > 0) {
    console.log(`Sold seats for ${showName}:`, taken);

    const soldMessage = [
      `❌ Sold: ${taken.join(", ")}`,
      "",
      "🎟 ART Cinemas - EPIQ Screen",
      `🕒 Show: ${showName}`,
      "",
      `🕒 ${timestamp()}`
    ].join("\n");

    await sendTelegram(soldMessage);
    previousState.set(showName, currentState);
  } else {
    console.log(`No seats became unavailable for ${showName}`);
  }

  previousState.set(showName, currentState);
  return false;
}

// ============================================================================
// MAIN LOOP & EXPORT
// ============================================================================
async function runArtWatcher() {
  let browser = null;
  let page = null;

  try {
    console.log("ART Cinemas EPIQ Watcher started.");

    while (true) {
      try {
        ({ browser, page } = await createBrowserPage());

        let restartScan = false;
        for (const showName of SHOW_TIMES) {
          const released = await checkSeats(page, showName);
          if (released) {
            restartScan = true;
            break;
          }
        }

        if (browser) {
          await browser.close();
          browser = null;
          page = null;
        }

        if (restartScan) {
          console.log("Seat released. Restarting scan immediately...");
          continue;
        }

        console.log(
          `Scan complete. Waiting ${CHECK_INTERVAL / 1000} seconds...`
        );
        await sleep(CHECK_INTERVAL);
      } catch (err) {
        console.error("Scan error:", err);

        if (browser) {
          try {
            await browser.close();
          } catch (closeErr) {
            console.error("Error closing browser:", closeErr);
          }
        }
        browser = null;
        page = null;

        console.log("Retrying in 10 seconds...");
        await sleep(10000);
      }
    }
  } catch (err) {
    console.error("Fatal error in ART Cinemas EPIQ Watcher:", err);
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = runArtWatcher;

// Run directly if executed via `node art-epiq-watcher.js`
if (require.main === module) {
  runArtWatcher();
}
