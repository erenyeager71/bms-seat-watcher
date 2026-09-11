const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

console.log(">>> script loaded");

const { chromium } = require("playwright");
const readline = require("readline");
const sendTelegram = require("./telegram");

// ============================================================================
// HELPERS & LOGGING
// ============================================================================
function timestamp() {
  return new Date().toLocaleTimeString();
}

function log(msg, prefix = "🧠 [BMS-BRAIN]") {
  console.log(`[${timestamp()}] ${prefix} ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function seatKey(row, seat) {
  return `${row}-${seat}`;
}

function getNextDateCode(dateStr) {
  if (!dateStr || dateStr.length !== 8) return "";
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(4, 6), 10) - 1;
  const d = parseInt(dateStr.slice(6, 8), 10);
  const dateObj = new Date(y, m, d + 1);
  const ny = dateObj.getFullYear();
  const nm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const nd = String(dateObj.getDate()).padStart(2, "0");
  return `${ny}${nm}${nd}`;
}

// ============================================================================
// CLI ARGUMENT PARSER
// ============================================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    url: "",
    movie: "",       // Target movie title filter
    screen: "ANY",   // EPIQ, PCX, IMAX, DOLBY, 4K, ANY
    shows: null,     // Array of showtimes or null for ALL
    targetRows: null, // Set of row letters or null for ALL
    targetDate: "",  // Target date YYYYMMDD
    interval: 5000
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--movie" || arg === "-m") {
      config.movie = (args[++i] || "").trim();
    } else if (arg === "--screen" || arg === "-s") {
      config.screen = args[++i] ? args[i].toUpperCase() : "ANY";
    } else if (arg === "--shows" || arg === "-t") {
      const showsStr = args[++i] || "";
      config.shows = showsStr.split(",").map(s => s.trim().toUpperCase());
    } else if (arg === "--rows" || arg === "-r") {
      const rowsStr = args[++i] || "";
      config.targetRows = new Set(rowsStr.split(",").map(r => r.trim().toUpperCase()));
    } else if (arg === "--date" || arg === "-d") {
      config.targetDate = (args[++i] || "").trim();
    } else if (arg === "--interval" || arg === "-i") {
      config.interval = parseInt(args[++i], 10) || 5000;
    } else if (!arg.startsWith("-") && !config.url) {
      config.url = arg;
    }
  }

  return config;
}

// ============================================================================
// MOVIE & SHOWTIME DISCOVERY ENGINE
// ============================================================================
async function discoverMoviesOnDatePage(page) {
  await page.waitForSelector('[role="button"], button, [class*="showtime"]', { timeout: 10000 }).catch(() => {});

  const pageData = await page.evaluate(() => window.__INITIAL_STATE__ || window.__NEXT_DATA__ || null);
  const movieMap = new Map();

  if (pageData?.venueShowtimesFunctionalApi?.queries) {
    const venueMatch = page.url().match(/\/buytickets\/([A-Z0-9]+)\/(\d{8})/);
    const venueCode = venueMatch ? venueMatch[1] : "PRHN";
    const dateCode = venueMatch ? venueMatch[2] : "";

    const queryEntries = Object.entries(pageData.venueShowtimesFunctionalApi.queries);
    const showtimeQuery = queryEntries.find(([key]) => key.startsWith("getShowtimesByVenue-"));
    const query = showtimeQuery ? showtimeQuery[1] : null;

    const events = query?.data?.showDetailsTransformed?.Event || [];

    for (const movie of events) {
      const title = movie.EventTitle || movie.EventName || "Movie";

      for (const childEvent of (movie.ChildEvents || [])) {
        const lang = childEvent.EventLanguage || "";
        const dim = childEvent.EventDimension || "";
        const eCode = childEvent.EventCode;
        const key = `${title} (${lang} ${dim})`.trim();

        if (!movieMap.has(key)) {
          movieMap.set(key, {
            title,
            lang,
            dim,
            eventCode: eCode,
            screens: new Set(),
            showtimes: []
          });
        }

        const entry = movieMap.get(key);

        for (const st of (childEvent.ShowTimes || [])) {
          const screenName = st.ScreenName || "";
          if (screenName) entry.screens.add(screenName);

          const seatLayoutUrl = `https://in.bookmyshow.com/movies/HYD/seat-layout/${eCode}/${venueCode}/${st.SessionId}/${dateCode}`;
          entry.showtimes.push({
            timeStr: st.ShowTime,
            screenName,
            availStatus: st.AvailStatus,
            url: seatLayoutUrl
          });
        }
      }
    }
  }

  return Array.from(movieMap.values());
}

async function promptUserForMovieAndShow(config, availableMovies) {
  if (!process.stdin.isTTY) {
    return config;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = query => new Promise(resolve => rl.question(query, resolve));

  // 1️⃣ Ask for target date first
  const urlDateMatch = config.url.match(/\/(\d{8})$/);
  const urlDate = urlDateMatch ? urlDateMatch[1] : "";
  const suggestedNextDate = urlDate ? getNextDateCode(urlDate) : "";

  if (!config.targetDate) {
    console.log("\n========================================================");
    console.log(" 📅 TARGET SHOW DATE SELECTION:");
    console.log(`  [1] Suggested Release Date: ${suggestedNextDate} (Next Day)`);
    console.log(`  [2] Current URL Date: ${urlDate}`);
    console.log("========================================================\n");

    const dateChoice = await question(`👉 Enter Target Date YYYYMMDD (press Enter for ${suggestedNextDate || urlDate}):\n> `);
    const trimmedDate = dateChoice.trim();
    if (trimmedDate === "2") {
      config.targetDate = urlDate;
    } else if (trimmedDate === "1") {
      config.targetDate = suggestedNextDate;
    } else {
      config.targetDate = trimmedDate ? trimmedDate : (suggestedNextDate || urlDate);
    }
  }

  // Update URL to the chosen date so later scans use correct page
  if (urlDate && config.targetDate && urlDate !== config.targetDate) {
    config.url = config.url.replace(/\/(\d{8})$/, `/${config.targetDate}`);
    console.log(`\n📌 Updated Target Venue URL to watch for date ${config.targetDate}:\n${config.url}\n`);
  }

  // 2️⃣ Ask for movie title
  const movieInput = await question("\n🎬 Enter Movie Title to search for (leave blank to pick from list):\n> ");
  if (movieInput.trim()) {
    config.movie = movieInput.trim();
  }

  // 3️⃣ Ask for screen/format
  const screenInput = await question("🎬 Enter Screen/Format filter (e.g. EPIQ, PCX, DOLBY, IMAX, or press Enter for ANY):\n> ");
  if (screenInput.trim()) {
    config.screen = screenInput.trim().toUpperCase();
  } else {
    config.screen = "ANY";
  }

  // 4️⃣ Optional: target rows
  const rowChoice = await question("👉 Enter target rows filter (e.g. G,H,I,J,K,L or press Enter for ALL):\n> ");
  if (rowChoice.trim()) {
    config.targetRows = new Set(rowChoice.split(",").map(r => r.trim().toUpperCase()));
  }

  // If user didn't give a movie, show available list for reference (optional)
  if (!config.movie && availableMovies.length > 0) {
    console.log("\n========================================================");
    console.log(" 🎬 MOVIES & SHOWTIMES AVAILABLE ON THIS DATE:");
    console.log("========================================================\n");
    availableMovies.forEach((m, idx) => {
      const screenStr = Array.from(m.screens).join(", ") || "Standard";
      const showStr = m.showtimes.map(s => s.timeStr).join(", ");
      console.log(`  [${idx + 1}] 🍿 ${m.title} (${m.lang} ${m.dim})`);
      console.log(`      Screens: ${screenStr}`);
      console.log(`      Showtimes: ${showStr}\n`);
    });
  }

  rl.close();
  return config;
}

// ============================================================================
// KONVA CANVAS SEAT WATCHER ENGINE
// ============================================================================
async function waitForKonva(page) {
  await page.waitForFunction(
    () => window.Konva && window.Konva.stages && window.Konva.stages.length > 0,
    { timeout: 25000 }
  ).catch(err => {
    log("⚠️ Konva canvas was not detected within timeout. Check if seat layout page is active or URL is valid.");
    throw err;
  });
}

async function clickSelectSeats(page) {
  try {
    const btn = page.getByRole("button", { name: "Select Seats" });
    if (await btn.isVisible({ timeout: 4000 })) {
      await btn.click();
      log("Opened seat map modal");
      await page.waitForTimeout(1000);
      return;
    }
  } catch {}

  try {
    const textBtn = page.locator("text=Select Seats").first();
    if (await textBtn.isVisible({ timeout: 2000 })) {
      await textBtn.click({ force: true });
      await page.waitForTimeout(1000);
    }
  } catch {}
}

async function extractSeatsFromKonva(page) {
  return await page.evaluate(() => {
    function walk(node, list) {
      if (!node) return;
      if (node.attrs && node.attrs.seatObj) {
        list.push(node.attrs.seatObj);
      }
      if (node.children) {
        for (const child of node.children) walk(child, list);
      }
    }

    const seats = [];
    if (!window.Konva) return seats;
    for (const stage of window.Konva.stages) walk(stage, seats);
    return seats;
  });
}

function buildSeatStateMap(seats, targetRows) {
  const map = new Map();
  for (const seat of seats) {
    const row = seat.rowNumber;
    if (targetRows && !targetRows.has(row.toUpperCase())) continue;
    map.set(seatKey(seat.rowNumber, seat.displaySeatNumber), seat.seatStatus);
  }
  return map;
}

async function discoverShowtimesOnSeatPage(page) {
  return await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], div[class*="time"], span'));
    const times = [];
    for (const b of buttons) {
      const text = (b.innerText || "").trim();
      const match = text.match(/(\d{1,2}:\d{2}\s?(?:AM|PM))/i);
      if (match && !times.includes(match[1])) {
        times.push(match[1]);
      }
    }
    return times;
  });
}

async function switchShowOnSeatPage(page, timeStr) {
  try {
    const target = page.locator(`text=${timeStr}`).first();
    if (await target.isVisible({ timeout: 3000 })) {
      await target.click({ force: true });
      log(`Switched seat map to showtime: ${timeStr}`);
      await page.waitForTimeout(2000);
    }
  } catch {}
}

// Function to click an open showtime on the date page and get its seat layout URL
async function getSeatLayoutUrlForShow(page, timeStr) {
  const targetLoc = page.locator('[role="button"], button')
    .filter({ hasText: timeStr })
    .first();

  if (await targetLoc.isVisible().catch(() => false)) {
    await targetLoc.click({ force: true });
    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    if (currentUrl.includes("seat-layout")) {
      return currentUrl;
    }
  }
  return null;
}

// ============================================================================
// MAIN AUTONOMOUS BRAIN ENGINE
// ============================================================================
async function runBmsBrain() {
  console.log(">>> runBmsBrain started");
  let config = parseArgs();

  if (!config.url) {
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const question = query => new Promise(resolve => rl.question(query, resolve));
      config.url = (await question("📌 Enter BookMyShow URL (Date page or Seat Layout page):\n> ")).trim();
      rl.close();
    }
  }

  if (!config.url) {
    console.log("No URL provided. Defaulting to Prasads Multiplex.");
    config.url = "https://in.bookmyshow.com/cinemas/HYD/prasads-multiplex-hyderabad/buytickets/PRHN/20260823";
  }

  log("========================================================");
  log(`🧠 BMS BRAIN ENGINE ACTIVATED`);
  log(`🔗 Target URL: ${config.url}`);
  log("========================================================");

  const isSeatLayoutUrl = config.url.includes("/seat-layout/");

  // If direct seat layout URL, run seat watcher engine immediately
  if (isSeatLayoutUrl) {
    return runBmsBrainSeatEngine(config);
  }

  // Handle Venue Date Page
  const dateMatch = config.url.match(/\/(\d{8})$/);
  const urlDateCode = dateMatch ? dateMatch[1] : "";
  const venueBaseUrl = config.url.replace(/\/\d{8}$/, ""); // e.g. .../buytickets/ALUC

  log("Scanning venue date page for currently available movies and showtimes...");
  const tempBrowser = await chromium.launch({ headless: false });
  const tempPage = await tempBrowser.newPage();
  await tempPage.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await tempPage.waitForTimeout(3000);
  const availableMovies = await discoverMoviesOnDatePage(tempPage);
  await tempBrowser.close();

  // Always ask the user what to watch for (movie/screen and target date)
  if (process.stdin.isTTY && !config.movie && config.screen === "ANY") {
    config = await promptUserForMovieAndShow(config, availableMovies);
  }

  // Resolve venue code from updated URL (may have changed date in prompt)
  const venueMatch = config.url.match(/\/buytickets\/([A-Z0-9]+)\/(\d{8})/);
  const venueCode = venueMatch ? venueMatch[1] : "PRHN";
  const targetDateCode = config.targetDate || urlDateCode;
  const targetDateUrl = `${venueBaseUrl}/${targetDateCode}`;

  log(`🎯 Target: Movie='${config.movie || "ANY"}' Screen='${config.screen}' Date=${targetDateCode}`);
  log(`🔗 Watching URL: ${targetDateUrl}`);

  // ── PHASE 1: Wait until BMS enables the target date ──────────────────────
  // BMS redirects to a different date when the target date is not open yet.
  log(`⏳ PHASE 1: Waiting for BMS to enable date ${targetDateCode} on this venue...`);
  while (true) {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    try {
      await page.goto(targetDateUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);

      const actualUrlMatch = page.url().match(/\/buytickets\/[A-Z0-9]+\/(\d{8})/);
      const actualDate = actualUrlMatch ? actualUrlMatch[1] : "";

      if (actualDate === targetDateCode) {
        log(`✅ PHASE 1 DONE: BMS has enabled date ${targetDateCode}!`);
        await browser.close();
        break;
      } else {
        log(`⏳ Date ${targetDateCode} not yet enabled (BMS redirected to ${actualDate}). Polling...`);
      }
    } catch (err) {
      log(`Error in Phase 1 date check: ${err.message}`);
    } finally {
      try { await browser.close(); } catch {}
    }
    await sleep(config.interval);
  }

  // ── PHASE 2: Wait until the target movie/screen appears on that date ──────
  log(`⏳ PHASE 2: Watching date ${targetDateCode} for '${config.movie || config.screen}'...`);
  let activeSeatLayoutUrl = null;

  while (!activeSeatLayoutUrl) {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    try {
      await page.goto(targetDateUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);

      // Re-check: if BMS redirects away from our target date, go back to Phase 1
      const actualUrlMatch = page.url().match(/\/buytickets\/[A-Z0-9]+\/(\d{8})/);
      const actualDate = actualUrlMatch ? actualUrlMatch[1] : "";
      if (actualDate && actualDate !== targetDateCode) {
        log(`⚠️ BMS redirected away from ${targetDateCode} to ${actualDate}. Reverting to Phase 1...`);
        await browser.close();
        // Re-run Phase 1 inline
        while (true) {
          const b2 = await chromium.launch({ headless: false });
          const p2 = await b2.newPage();
          try {
            await p2.goto(targetDateUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
            await p2.waitForTimeout(2000);
            const m2 = p2.url().match(/\/buytickets\/[A-Z0-9]+\/(\d{8})/);
            const d2 = m2 ? m2[1] : "";
            if (d2 === targetDateCode) { log(`✅ Date ${targetDateCode} re-enabled!`); await b2.close(); break; }
            else { log(`⏳ Still waiting for date ${targetDateCode} (got ${d2})...`); }
          } catch (e) { log(`Phase 1 retry error: ${e.message}`); }
          finally { try { await b2.close(); } catch {} }
          await sleep(config.interval);
        }
        continue;
      }

      const movies = await discoverMoviesOnDatePage(page);
      const movieTerm = config.movie ? config.movie.toUpperCase() : "";
      const screenTerm = config.screen && config.screen !== "ANY" ? config.screen.toUpperCase() : "";

      let matchedMovie = null;
      if (movieTerm && screenTerm) {
        matchedMovie = movies.find(m =>
          m.title.toUpperCase().includes(movieTerm) &&
          (m.dim.toUpperCase().includes(screenTerm) || m.title.toUpperCase().includes(screenTerm))
        );
      } else if (movieTerm) {
        matchedMovie = movies.find(m => m.title.toUpperCase().includes(movieTerm));
      } else if (screenTerm) {
        matchedMovie = movies.find(m =>
          m.dim.toUpperCase().includes(screenTerm) || m.title.toUpperCase().includes(screenTerm)
        );
      }
      // NOTE: No fallback to movies[0] — we only match what the user asked for

      if (matchedMovie && matchedMovie.showtimes.length > 0) {
        let targetShow = matchedMovie.showtimes.find(s =>
          s.availStatus === 1 || s.availStatus === 3 || s.availStatus === "1" || s.availStatus === "3"
        ) || matchedMovie.showtimes[0];

        log(`🎉 MOVIE FOUND: ${matchedMovie.title} - ${targetShow.timeStr} (${targetShow.screenName || config.screen})!`);

        let layoutUrl = targetShow.url || null;
        if (!layoutUrl) layoutUrl = await getSeatLayoutUrlForShow(page, targetShow.timeStr);

        if (layoutUrl) {
          activeSeatLayoutUrl = layoutUrl;
          config.url = layoutUrl;
          await sendTelegram([
            `🚨 SHOW IS NOW AVAILABLE FOR BOOKING! 🎉`,
            `🍿 Movie: ${matchedMovie.title}`,
            `🎬 Screen: ${targetShow.screenName || config.screen}`,
            `🕒 Show Time: ${targetShow.timeStr}`,
            `📅 Date: ${targetDateCode}`,
            ``,
            `🔗 ${layoutUrl}`,
            `🕒 ${timestamp()}`
          ].join("\n"));
        }
      } else {
        log(`⏳ '${config.movie || config.screen}' not yet on BMS for ${targetDateCode}. Watching...`);
      }
    } catch (err) {
      log(`Error in Phase 2 scan: ${err.message}`);
    } finally {
      try { await browser.close(); } catch {}
    }

    if (!activeSeatLayoutUrl) await sleep(config.interval);
  }


  log("========================================================");
  log(`🎟 OPENING SEAT MAP & STARTING SEAT SCANNING`);
  log(`🔗 Seat Layout URL: ${config.url}`);
  log("========================================================");

  return runBmsBrainSeatEngine(config);
}

async function runBmsBrainSeatEngine(config) {
  log("========================================================");
  log(`🎟 SEAT WATCHER ACTIVATED: Monitoring seat map & cancellations...`);
  log(`🔗 Seat Layout URL: ${config.url}`);
  log("========================================================");

  let activeSeatLayoutUrl = config.url;
  const previousState = new Map();

  while (true) {
    let browser = null;
    let page = null;

    try {
      browser = await chromium.launch({ headless: false });
      page = await browser.newPage();

      await page.goto(activeSeatLayoutUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await clickSelectSeats(page);
      await waitForKonva(page);
      await page.waitForTimeout(2000);

      let showtimesToScan = config.shows;
      if (!showtimesToScan || showtimesToScan.length === 0) {
        const discovered = await discoverShowtimesOnSeatPage(page);
        showtimesToScan = discovered.length > 0 ? discovered : ["PRIMARY SHOW"];
      }

      log(`Scanning showtimes on seat map: ${showtimesToScan.join(", ")}`);
      let seatsChanged = false;

      for (const timeStr of showtimesToScan) {
        if (showtimesToScan.length > 1 && timeStr !== "PRIMARY SHOW") {
          await clickSelectSeats(page);
          await switchShowOnSeatPage(page, timeStr);
          await clickSelectSeats(page);
          await waitForKonva(page);
          await page.waitForTimeout(1500);
        }

        const seats = await extractSeatsFromKonva(page);
        const currentState = buildSeatStateMap(seats, config.targetRows);
        const prevShowState = previousState.get(timeStr);

        if (!prevShowState || prevShowState.size === 0) {
          previousState.set(timeStr, currentState);

          let availableCount = 0;
          const rowCounts = new Map();

          for (const [sKey, status] of currentState) {
            if (status === 1) {
              availableCount++;
              const r = sKey.split("-")[0];
              rowCounts.set(r, (rowCounts.get(r) || 0) + 1);
            }
          }

          const availableRows = Array.from(rowCounts.keys());
          const rowDetails = availableRows.map(r => `• Row ${r}: ${rowCounts.get(r)} seats`);

          const overviewMsg = [
            `📊 BMS Brain Seat Scan Overview`,
            `🍿 Movie: ${config.movie || "BookMyShow Movie"}`,
            `🎬 Show: ${timeStr}`,
            `🎟 Available Seats: ${availableCount} across ${availableRows.length} rows`,
            "",
            "Row Breakdown:",
            ...(rowDetails.length > 0 ? rowDetails : ["No seats available"]),
            "",
            `🔗 ${activeSeatLayoutUrl}`,
            `🕒 ${timestamp()}`
          ].join("\n");

          log(`Initial seat map scan complete for ${timeStr} (${availableCount} available seats across ${availableRows.length} rows)`);
          await sendTelegram(overviewMsg);
          continue;
        }

        const releasedSeats = [];
        const bookedSeats = [];

        for (const [sKey, status] of currentState) {
          const prev = prevShowState.get(sKey);
          const wasAvail = prev === 1;
          const isAvail = status === 1;

          if (!wasAvail && isAvail) releasedSeats.push(sKey);
          if (wasAvail && !isAvail) bookedSeats.push(sKey);
        }

        if (releasedSeats.length > 0) {
          log(`🎉 SEATS RELEASED for ${timeStr}: ${releasedSeats.join(", ")}`);
          await sendTelegram([
            `🎉 SEATS RELEASED!`,
            `🍿 Movie: ${config.movie || "Movie"}`,
            `🕒 Show: ${timeStr}`,
            `🎟 Released: ${releasedSeats.join(", ")}`,
            "",
            `🔗 ${activeSeatLayoutUrl}`,
            `🕒 ${timestamp()}`
          ].join("\n"));
          seatsChanged = true;
        }

        if (bookedSeats.length > 0) {
          log(`❌ Seats booked for ${timeStr}: ${bookedSeats.join(", ")}`);
        }

        previousState.set(timeStr, currentState);
      }

      await browser.close();
      browser = null;
      page = null;

      if (seatsChanged) {
        log("Seat status changed. Rescanning immediately...");
        continue;
      }

      log(`Scan loop complete. Next check in ${config.interval / 1000}s...`);
      await sleep(config.interval);

    } catch (err) {
      log(`Error in seat watcher loop: ${err.message}`);
      if (browser) {
        try { await browser.close(); } catch {}
      }
      browser = null;
      page = null;
      await sleep(10000);
    }
  }
}

if (require.main === module) {
  runBmsBrain().catch(console.error);
}

module.exports = runBmsBrain;
