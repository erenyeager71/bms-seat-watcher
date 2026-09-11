const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const { chromium } = require("playwright");
const fs = require("fs");

// ============================================================================
// CONFIGURATION: Saturday EPIQ Release Watcher
// ============================================================================
// Date page URL for Saturday (production)
const DATE_PAGE_URL =
  "https://in.bookmyshow.com/cinemas/HYD/art-cinemas-vanasthalipuram/buytickets/ACEV/20260823";

// Target screen type to watch for
const TARGET_SCREEN = "EPIQ";

// Interval between checks (in milliseconds)
const CHECK_INTERVAL = 5000; // 5 seconds

// Path to art-epiq-watcher.js to update the URL
const ART_EPIQ_WATCHER_PATH = path.join(__dirname, "art-epiq-watcher.js");

// ============================================================================
// HELPERS
// ============================================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toLocaleTimeString();
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

// ============================================================================
// EXTRACT EPIQ SEAT LAYOUT URL FROM PAGE DATA
// ============================================================================
async function extractEpiqSeatLayoutUrl(page, dateCode) {
  try {
    log("Checking website HTML and page state for EPIQ showtimes...");

    // =========================================================================
    // METHOD 1: WEBSITE HTML DOM MATCHING (Primary)
    // =========================================================================
    await page.waitForSelector('[role="button"], button, [class*="showtime"]', { timeout: 10000 }).catch(() => {});

    const domEpiqShows = await page.evaluate(() => {
      const shows = [];
      const candidates = Array.from(document.querySelectorAll('[role="button"], button, a, [class*="showtime"]'));

      for (const el of candidates) {
        const text = (el.innerText || "").trim();
        const ariaLabel = el.getAttribute("aria-label") || "";
        if (!text && !ariaLabel) continue;

        let isEpiq = text.toUpperCase().includes("EPIQ") || ariaLabel.toUpperCase().includes("EPIQ");

        if (!isEpiq) {
          let cur = el.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!cur || cur === document.body) break;
            const formatEls = cur.querySelectorAll('span, div[class*="format"], div[class*="sc-"]');
            for (const fe of formatEls) {
              const feText = (fe.innerText || "").trim().toUpperCase();
              if (feText === "EPIQ" || feText === ", EPIQ" || feText.includes("EPIQ")) {
                const siblingBtns = cur.querySelectorAll('[role="button"], button');
                if (siblingBtns.length < 20) {
                  isEpiq = true;
                  break;
                }
              }
            }
            if (isEpiq) break;
            cur = cur.parentElement;
          }
        }

        const isShowtime = /\d{1,2}:\d{2}\s?(AM|PM)/i.test(text || ariaLabel);

        if (isEpiq && isShowtime) {
          const tabindex = el.getAttribute("tabindex");
          const ariaDisabled = el.getAttribute("aria-disabled");
          const isSoldOut = tabindex === "-1" || ariaDisabled === "true" || el.className.includes("disabled") || el.className.includes("sold");

          const timeMatch = (text || ariaLabel).match(/(\d{1,2}:\d{2}\s?(?:AM|PM))/i);
          const timeStr = timeMatch ? timeMatch[1] : text;

          shows.push({
            timeStr,
            fullText: text.replace(/\n/g, " ") || ariaLabel,
            isSoldOut
          });
        }
      }

      const unique = new Map();
      for (const s of shows) {
        if (!unique.has(s.timeStr)) unique.set(s.timeStr, s);
      }
      return Array.from(unique.values());
    });

    log(`DOM HTML check found ${domEpiqShows.length} EPIQ showtime element(s)`);

    const availableDomShow = domEpiqShows.find(s => !s.isSoldOut);
    if (availableDomShow) {
      log(`Available EPIQ show found in HTML DOM: ${availableDomShow.timeStr} (${availableDomShow.fullText})`);
      log("Clicking EPIQ showtime button in HTML to obtain seat layout URL...");

      const targetLoc = page.locator('[role="button"], button')
        .filter({ hasText: availableDomShow.timeStr })
        .filter({ hasText: /EPIQ/i })
        .first();

      let clickedLoc = targetLoc;
      if (!(await clickedLoc.isVisible().catch(() => false))) {
        clickedLoc = page.locator('[role="button"], button')
          .filter({ hasText: availableDomShow.timeStr })
          .first();
      }

      if (await clickedLoc.isVisible().catch(() => false)) {
        await clickedLoc.click();
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        if (currentUrl.includes("seat-layout")) {
          log(`Found seat layout URL via HTML DOM click: ${currentUrl}`);
          return { url: currentUrl, showName: `${availableDomShow.timeStr} EPIQ` };
        }
      }
    }

    // =========================================================================
    // METHOD 2: INITIAL STATE JSON DATA MATCHING (Fallback)
    // =========================================================================
    log("Checking page state data (__INITIAL_STATE__)...");
    const pageData = await page.evaluate(() => window.__INITIAL_STATE__ || window.__NEXT_DATA__ || null);

    if (pageData?.venueShowtimesFunctionalApi?.queries) {
      const queryKey = `getShowtimesByVenue-ACEV-${dateCode}`;
      const query = pageData.venueShowtimesFunctionalApi.queries[queryKey];
      const events = query?.data?.showDetailsTransformed?.Event || [];

      log(`Found ${events.length} movies/events in state data`);

      for (const movie of events) {
        if (!movie.ChildEvents) continue;

        for (const childEvent of movie.ChildEvents) {
          if (!childEvent.ShowTimes) continue;

          const dimension = (childEvent.EventDimension || "").toUpperCase();
          const eventName = (childEvent.EventName || "").toUpperCase();
          const eventCode = childEvent.EventCode;

          for (const showtime of childEvent.ShowTimes) {
            const screenName = (showtime.ScreenName || "").toUpperCase();
            const isEpiq = dimension.includes("EPIQ") || eventName.includes("EPIQ") || screenName.includes("EPIQ");

            const availStatus = showtime.AvailStatus;
            const isAvailable = availStatus === 1 || availStatus === "1" || availStatus === 3 || availStatus === "3";

            if (isEpiq && isAvailable) {
              const sessionId = showtime.SessionId;
              const showTime = showtime.ShowTime;
              log(`Found available EPIQ show in State JSON: ${showTime} | EventCode: ${eventCode} | SessionId: ${sessionId} | Screen: ${screenName}`);

              const seatLayoutUrl = `https://in.bookmyshow.com/movies/HYD/seat-layout/${eventCode}/ACEV/${sessionId}/${dateCode}`;
              log(`Seat layout URL: ${seatLayoutUrl}`);

              return { url: seatLayoutUrl, showName: `${showTime} EPIQ` };
            }
          }
        }
      }
    }

    log("No available EPIQ shows found in HTML DOM or State JSON data");
    return null;
  } catch (err) {
    log(`Error extracting EPIQ URL: ${err.message}`);
    return null;
  }
}

// ============================================================================
// UPDATE ART-EPIQ-WATCHER.JS
// ============================================================================
function updateArtEpiqWatcherUrl(newUrl) {
  try {
    let content = fs.readFileSync(ART_EPIQ_WATCHER_PATH, "utf8");
    
    // Replace the URL line - match any bookmyshow seat-layout URL
    const urlRegex = /const URL\s*=\s*["']https:\/\/in\.bookmyshow\.com\/[^"']+["']/;
    const newUrlLine = `const URL =\n  "${newUrl}";`;
    
    if (urlRegex.test(content)) {
      content = content.replace(urlRegex, newUrlLine);
      fs.writeFileSync(ART_EPIQ_WATCHER_PATH, content);
      log(`Updated art-epiq-watcher.js with new URL: ${newUrl}`);
      return true;
    } else {
      log("Could not find URL pattern in art-epiq-watcher.js");
      return false;
    }
  } catch (err) {
    log(`Error updating art-epiq-watcher.js: ${err.message}`);
    return false;
  }
}

// ============================================================================
// MAIN WATCHER LOOP
// ============================================================================
async function runSaturdayEpiqWatcher() {
  let found = false;

  log("Saturday EPIQ Release Watcher started.");
  log(`Monitoring: ${DATE_PAGE_URL}`);
  log(`Looking for: ${TARGET_SCREEN} screen shows`);

  // Extract date code from URL
  const dateCodeMatch = DATE_PAGE_URL.match(/\/(\d{8})$/);
  const dateCode = dateCodeMatch ? dateCodeMatch[1] : "20260823";
  log(`Date code: ${dateCode}`);

  while (!found) {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    
    try {
      log("Loading date page...");
      await page.goto(DATE_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      log("Extracting EPIQ seat layout URL from page data...");

      const result = await extractEpiqSeatLayoutUrl(page, dateCode);

      if (result) {
        log(`🎉 EPIQ show found! ${result.showName}`);
        log(`Seat layout URL: ${result.url}`);
        
        const updated = updateArtEpiqWatcherUrl(result.url);
        
        if (updated) {
          log("✅ art-epiq-watcher.js updated successfully!");
          log("🚀 Automatically launching art-epiq-watcher.js to monitor seats...");
          
          // Clear require cache to ensure fresh module load with updated URL
          delete require.cache[require.resolve("./art-epiq-watcher.js")];
          const runArtWatcher = require("./art-epiq-watcher.js");
          
          // Close release watcher browser before handing over to seat watcher
          try { await browser.close(); } catch {}

          await runArtWatcher();
          return;
        }
        
        found = true;
      } else {
        log(`No EPIQ shows found. Retrying in ${CHECK_INTERVAL / 1000}s...`);
      }
    } catch (err) {
      log(`Error: ${err.message}`);
    } finally {
      try { await browser.close(); } catch {}
    }

    if (!found) {
      await sleep(CHECK_INTERVAL);
    }
  }
  
  log("Saturday EPIQ Watcher completed. EPIQ show found and URL updated.");
}

module.exports = runSaturdayEpiqWatcher;

if (require.main === module) {
  runSaturdayEpiqWatcher();
}