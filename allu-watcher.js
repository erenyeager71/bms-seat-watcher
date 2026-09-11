const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const { chromium } = require("playwright");
const sendTelegram = require("./telegram");

const URL =
  "https://in.bookmyshow.com/movies/hyd/seat-layout/ET00502689/ALUC/3050/20260803";

const SHOW_TIMES = [
    "10:00 AM DOLBY CINEMA",
    "01:10 PM DOLBY CINEMA",
    "04:35 PM DOLBY CINEMA",
    "08:00 PM DOLBY CINEMA",
    "11:15 PM DOLBY CINEMA"
];

// Actual button names Playwright recorded
const SHOW_BUTTON_NAMES = {
    "10:00 AM DOLBY CINEMA": "10:00 AM DOLBY CINEMA",
    "01:10 PM DOLBY CINEMA": "01:10 PM DOLBY CINEMA",
    "04:35 PM DOLBY CINEMA": "04:35 PM DOLBY CINEMA",
    "08:00 PM DOLBY CINEMA": "08:00 PM DOLBY CINEMA",
    "11:15 PM DOLBY CINEMA": "11:15 PM DOLBY CINEMA"
};

const CHECK_INTERVAL = 5000;

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
        timeout: 15000
    });

}

async function clickSelectSeats(page) {

    try {

        const btn = page.getByRole("button", {
            name: "Select Seats"
        });

        if (await btn.isVisible({ timeout: 5000 })) {

            await btn.click();
            console.log("Opened seat map");

        }

    } catch {

        // Already open

    }

}

// KEEP ONLY THIS selectShow() FUNCTION
async function selectShow(page, showName) {

    try {

        const buttonName = SHOW_BUTTON_NAMES[showName] || showName;

        const btn = page.getByRole("button", {
            name: buttonName,
            exact: false
        });

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

    return {
        browser,
        page
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
            "🎟 ALLU Cinemas",
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
    "🎟 ALLU Cinemas",
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

    try {

        console.log("ALLU Watcher started.");

        while (true) {

            try {

                ({ browser, page } =
                    await createBrowserPage());

                let restartScan = false;

for (const showName of SHOW_TIMES) {

    const released = await checkSeats(page, showName);

    if (released) {

        restartScan = true;
        break;

    }

}
 await browser.close();
 browser = null;
 page = null;
 if (restartScan) {
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