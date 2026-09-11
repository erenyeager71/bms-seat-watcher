const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const readline = require("readline");
const { chromium } = require("playwright");
const sendTelegram = require("./telegram");

const URL =
  "https://in.bookmyshow.com/movies/HYD/seat-layout/ET00502600/PRHN/251976/20260802";

const CHECK_INTERVAL = 5000;

// Matches strings like "10:00 AM", "4:05 PM", "07:45 PM IMAX", etc.
const SHOW_TIME_PATTERN = /\d{1,2}:\d{2}\s?(AM|PM)/i;

let previousState = new Map();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function seatKey(row, seat) {
    return `${row}-${seat}`;
}

function normalizeText(s) {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function timestamp() {
    return new Date().toLocaleTimeString();
}

// Watch every seat
function isTargetSeat(seat) {
    return true;
}

function buildState(seats) {

    const map = new Map();

    for (const seat of seats) {

        if (!isTargetSeat(seat))
            continue;

        map.set(
            seatKey(
                seat.rowNumber,
                seat.displaySeatNumber
            ),
            seat.seatStatus
        );
    }

    return map;
}

async function waitForKonva(page) {

    await page.waitForFunction(() => {

        return (
            window.Konva &&
            window.Konva.stages &&
            window.Konva.stages.length > 0
        );

    }, {
        timeout: 30000
    });

}

async function clickSelectSeats(page) {

    try {

        const btn = page.getByRole("button", {
            name: "Select Seats"
        });

        await btn.waitFor({
            state: "visible",
            timeout: 15000
        });

        await btn.click();

        console.log("Opened seat map");

    } catch {

        // Already open, or button never appeared (assume seat map is already showing)
        console.log("Select Seats button not found (may already be open)");

    }

}

// Scrapes the show-time buttons that appear after clicking "Select Seats".
// Returns an array of exact button text strings, e.g. ["10:00 AM", "01:30 PM IMAX"]
async function discoverShows(page) {

    await page.waitForTimeout(2000);

    const buttons = await page.getByRole("button").all();

    const shows = [];
    const seen = new Set();

    for (const btn of buttons) {

        let text = "";

        try {

            text = (await btn.innerText({ timeout: 2000 })).trim();

        } catch {

            continue;

        }

        if (!text || seen.has(text))
            continue;

        if (SHOW_TIME_PATTERN.test(text)) {

            shows.push(text);
            seen.add(text);

        }

    }

    return shows;

}

function promptUserForShow(shows) {

    return new Promise((resolve, reject) => {

        if (shows.length === 0) {

            reject(new Error("No show times found on the page."));
            return;

        }

        console.log("\nAvailable shows:");

        shows.forEach((show, i) => {

            console.log(`  ${i + 1}. ${show}`);

        });

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(
            "\nWhich show do you want to watch? (enter the number): ",
            answer => {

                rl.close();

                const trimmed = answer.trim();

                const index = parseInt(trimmed, 10) - 1;

                if (
                    !isNaN(index) &&
                    index >= 0 &&
                    index < shows.length
                ) {

                    resolve(shows[index]);
                    return;

                }

                // Fallback: user typed the show name instead of a number.
                const match = shows.find(
                    show => normalizeText(show) === normalizeText(trimmed)
                );

                if (match) {

                    resolve(match);
                    return;

                }

                const partial = shows.find(
                    show => normalizeText(show).includes(normalizeText(trimmed))
                );

                if (partial) {

                    resolve(partial);
                    return;

                }

                reject(new Error(
                    `Invalid selection: "${trimmed}". Please enter a number from the list.`
                ));

            }
        );

    });

}

async function findShowButton(page, showName) {

    const target = normalizeText(showName);

    const buttons = await page.getByRole("button").all();

    for (const btn of buttons) {

        let text = "";

        try {

            text = await btn.innerText({ timeout: 2000 });

        } catch {

            continue;

        }

        const normalized = normalizeText(text);

        if (
            normalized === target ||
            normalized.includes(target) ||
            target.includes(normalized)
        ) {

            return btn;

        }

    }

    return null;

}

async function selectShow(page, showName) {

    try {

        const btn = await findShowButton(page, showName);

        if (!btn) {

            throw new Error("Button not found among available buttons");

        }

        await btn.waitFor({
            state: "visible",
            timeout: 5000
        });

        await btn.click();

        console.log(`Selected show: ${showName}`);

        // Give BookMyShow time to reload the seat map
        await page.waitForTimeout(1500);

    } catch (err) {

        console.error(
            `Could not select ${showName}:`,
            err.message
        );

    }

}

async function extractSeats(page) {

    return await page.evaluate(() => {

        function walk(node, list) {

            if (!node)
                return;

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

        if (!window.Konva)
            return seats;

        for (const stage of window.Konva.stages) {

            walk(stage, seats);

        }

        return seats;

    });

}

// Launches the browser and returns it with the show already picked by the user.
async function createBrowserPageAndPickShow() {

    const browser = await chromium.launch({
        headless: false
    });

    const page = await browser.newPage();

    await page.goto(URL, {
        waitUntil: "networkidle",
        timeout: 60000
    });

    await clickSelectSeats(page);

    const shows = await discoverShows(page);

    const selectedShow = await promptUserForShow(shows);

    await waitForKonva(page);

    await page.waitForTimeout(3000);

    return {
        browser,
        page,
        selectedShow
    };

}

async function grabCurrentState(page, showName) {

    await clickSelectSeats(page);

    await selectShow(page, showName);

    await waitForKonva(page);

    await page.waitForTimeout(2000);

    const seats = await extractSeats(page);

    console.log(
        `Found ${seats.length} seats for ${showName}`
    );

    return buildState(seats);

}

async function checkSeats(page, showName) {

    console.log(
        `\n[${timestamp()}] Checking ${showName}...`
    );

    const currentState = await grabCurrentState(
        page,
        showName
    );

    const previousShowState =
        previousState.get(showName);

    if (
        !previousShowState ||
        previousShowState.size === 0
    ) {

        previousState.set(
            showName,
            currentState
        );

        console.log(
            `Initial state saved for ${showName}`
        );

        return false;

    }

    const released = [];
    const taken = [];

    for (const [seat, status] of currentState) {

        const previous =
            previousShowState.get(seat);

        const wasAvailable =
            previous === 1;

        const isAvailable =
            status === 1;

        if (!wasAvailable && isAvailable) {

            released.push(seat);

        }

        if (wasAvailable && !isAvailable) {

            taken.push(seat);

        }

    }

    if (released.length > 0) {

        console.log(
            `Released seats for ${showName}:`,
            released
        );

        const message = [
            `🎟 Released: ${released.join(", ")}`,
            "🎉 Seats Released!",
            "🎟 Prasads Cinemas",
            `🕒 Show: ${showName}`,
            "",
            "Released seats:",
            ...released.map(seat => `• ${seat}`),
            "",
            `🔗 ${URL}`,
            `🕒 ${timestamp()}`

        ].join("\n");

        await sendTelegram(message);
        previousState.set(
            showName,
            currentState
        );

        return true;

    } else {

        console.log(
            `No releases for ${showName}`
        );

    }

    if (taken.length > 0) {

        console.log(
            `Sold seats for ${showName}:`,
            taken
        );

        const soldMessage = [

            `❌ Sold: ${taken.join(", ")}`,
            "",
            "🎟 Prasads Cinemas",
            `🕒 Show: ${showName}`,
            "",
            `🕒 ${timestamp()}`
        ].join("\n");

        await sendTelegram(soldMessage);
        previousState.set(
            showName,
            currentState
        );

    } else {

        console.log(
            `No seats became unavailable for ${showName}`
        );

    }

    previousState.set(
        showName,
        currentState
    );

    return false;

}

(async () => {

    let browser = null;
    let page = null;

    // Ask which show to watch once, up front, before the loop starts.
    let selectedShow;

    try {

        console.log("Prasads Watcher started.");

        // Retry the initial browser launch / show-selection phase,
        // since a transient failure here used to crash the whole script.
        const MAX_STARTUP_ATTEMPTS = 10;
        let startupAttempt = 0;
        let initial = null;

        while (!initial) {

            startupAttempt++;

            try {

                initial = await createBrowserPageAndPickShow();

            } catch (err) {

                console.error(
                    `Startup attempt ${startupAttempt} failed:`,
                    err.message
                );

                if (browser) {

                    try {

                        await browser.close();

                    } catch {

                        // ignore

                    }

                }

                browser = null;
                page = null;

                if (startupAttempt >= MAX_STARTUP_ATTEMPTS) {

                    throw new Error(
                        `Startup failed after ${MAX_STARTUP_ATTEMPTS} attempts.`
                    );

                }

                console.log("Retrying startup in 5 seconds...");

                await sleep(5000);

            }

        }

        browser = initial.browser;
        page = initial.page;
        selectedShow = initial.selectedShow;

        console.log(`\nWatching show: ${selectedShow}\n`);

        await browser.close();
        browser = null;
        page = null;

        while (true) {

            try {

                const browserObj = await chromium.launch({
                    headless: false
                });

                page = await browserObj.newPage();
                browser = browserObj;

                await page.goto(URL, {
                    waitUntil: "networkidle",
                    timeout: 60000
                });

                const released = await checkSeats(page, selectedShow);

                await browser.close();
                browser = null;
                page = null;

                if (released) {

                    console.log("Seat released. Restarting scan immediately...");
                    continue;

                }

                console.log(
                    `Scan complete. Waiting ${CHECK_INTERVAL / 1000} seconds...`
                );

                await sleep(CHECK_INTERVAL);

            } catch (err) {

                console.error(
                    "Scan error:",
                    err
                );

                if (browser) {

                    try {

                        await browser.close();

                    } catch (closeErr) {

                        console.error(
                            "Error closing browser:",
                            closeErr
                        );

                    }

                }

                browser = null;
                page = null;

                console.log(
                    "Retrying in 10 seconds..."
                );

                await sleep(10000);

            }

        }

    } catch (err) {

        console.error(
            "Fatal error:",
            err
        );

        if (browser) {

            await browser.close();

        }

    }

})();