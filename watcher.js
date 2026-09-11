const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const { chromium } = require("playwright");
const sendTelegram = require("./telegram");

const URL ="https://in.bookmyshow.com/movies/HYD/seat-layout/ET00502600/PRHN/251976/20260802";

const TARGET_ROWS = new Set(["G","H","I","J","K","L","M","N"]);
const MIN_SEAT = 15;
const MAX_SEAT = 32;

const SHOW_TIMES = [
    '12:15 PM PCX SCREEN',
    '03:45 PM PCX SCREEN',
    '07:15 PM PCX SCREEN',
    '10:45 PM PCX SCREEN'
];

const CHECK_INTERVAL = 20000;

let previousState = new Map();

function sleep(ms){
    return new Promise(r=>setTimeout(r,ms));
}

function seatKey(row,seat){
    return `${row}-${seat}`;
}

function timestamp(){
    return new Date().toLocaleTimeString();
}
function isTargetSeat(seat){

    const row = seat.rowNumber;
    const number = Number(seat.displaySeatNumber);

    return (
        TARGET_ROWS.has(row) &&
        number>=MIN_SEAT &&
        number<=MAX_SEAT
    );

}

function buildState(seats){

    const map = new Map();

    for(const seat of seats){

        if(!isTargetSeat(seat))
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
async function waitForKonva(page){

    await page.waitForFunction(() => {

        return (
            window.Konva &&
            window.Konva.stages &&
            window.Konva.stages.length>0
        );

    },{
        timeout:15000
    });

}
async function clickSelectSeats(page){
    try {
        const btn = page.getByRole('button', { name: 'Select Seats' });

        if (await btn.isVisible({ timeout: 5000 })) {
            await btn.click();
            console.log("Opened seat map");
        }
    } catch {
        // already open or not visible yet
    }
}

async function selectShow(page, showName) {
    try {
        const btn = page.getByRole('button', { name: showName });

        if (await btn.isVisible({ timeout: 5000 })) {
            await btn.click();
            console.log(`Selected show ${showName}`);
        }
    } catch (err) {
        console.error(`Could not select show ${showName}:`, err.message || err);
    }
}

async function extractSeats(page){

    return await page.evaluate(()=>{

        function walk(node,list){

            if(!node)
                return;

            if(node.attrs && node.attrs.seatObj){

                list.push(node.attrs.seatObj);

            }

            if(node.children){

                for(const child of node.children){

                    walk(child,list);

                }

            }

        }

        const seats=[];

        if(!window.Konva)
            return seats;

        for(const stage of window.Konva.stages){

            walk(stage,seats);

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

async function grabCurrentState(page, showName) {
    await clickSelectSeats(page);
    await selectShow(page, showName);

    await waitForKonva(page);
    await page.waitForTimeout(2000);

    const seats = await extractSeats(page);

    console.log(`Found ${seats.length} seats for ${showName}`);

    return buildState(seats);
}

async function checkSeats(page, showName) {
    console.log(`\n[${timestamp()}] Checking seats for ${showName}...`);

    const currentState = await grabCurrentState(page, showName);

    const previousShowState = previousState.get(showName);

    if (!previousShowState || previousShowState.size === 0) {
        previousState.set(showName, currentState);
        console.log(`Initial state saved for ${showName}.`);
        return false;
    }

    const released = [];
    const taken = [];

    for (const [seat, status] of currentState) {
        const previous = previousShowState.get(seat);

        // 2 = booked/held
        // 1 = available

        if (previous === 2 && status === 1) {
            released.push(seat);
        }

        if (previous === 1 && status === 2) {
            taken.push(seat);
        }
    }

    if (released.length > 0) {
        console.log(`Released for ${showName}:`, released);

        const message = [
          ...released.map((seat) => `- ${seat}`),
            `🎉 Seats Released!`,
            `🎟 Prasads PCX`,
            `🕒 Show: ${showName}`,
            ``,
            `Released seats:`,
            ...released.map((seat) => `- ${seat}`),
            ``,
            `Link: ${URL}`,
            `Scan time: ${timestamp()}`
        ].join('\n');

        await sendTelegram(message);
    } else {
        console.log(`No new releases for ${showName}.`);
    }

    if (taken.length > 0) {
        console.log(`Now unavailable for ${showName}:`, taken);

        // send concise sold notifications per seat
        for (const seat of taken) {
            const soldMsg = [
              `Seat: ${seat}`,
                `⚠️ Seat Sold`,
                `🎟 Prasads PCX`,
                `🕒 Show: ${showName}`,
                `Seat: ${seat}`,
                `Link: ${URL}`,
                `Time: ${timestamp()}`
            ].join('\n');

            await sendTelegram(soldMsg);
        }
    } else {
        console.log(`No seats became unavailable for ${showName}.`);
    }

    previousState.set(showName, currentState);
    // Return whether any releases were detected in this show.
    return released.length > 0;
}

// Main watcher loop: launch a fresh browser for each scan cycle and close it when done.
// Each loop iteration:
// - Opens a browser and page.
// - Scans all shows sequentially.
// - Closes the browser immediately when the cycle completes.
// - If a release is detected, the next cycle starts immediately without waiting.

(async () => {
    try {
        while (true) {
            let browser = null;
            let page = null;
            let anyRelease = false;

            try {
                console.log("Watcher cycle: launching browser.");
                ({ browser, page } = await createBrowserPage());

                for (const showName of SHOW_TIMES) {
                    const released = await checkSeats(page, showName);
                    if (released) {
                        anyRelease = true;
                        break;
                    }
                }

                if (anyRelease) {
                    console.log("Release detected: starting immediate rescan.");
                } else {
                    console.log(`Scan complete. Waiting ${CHECK_INTERVAL}ms before next scan.`);
                    await sleep(CHECK_INTERVAL);
                }
            } catch (err) {
                console.error('Scan error:', err);
            } finally {
                if (page) {
                    try {
                        await page.close();
                    } catch (closeErr) {
                        console.error('Error closing page:', closeErr);
                    }
                }

                if (browser) {
                    try {
                        await browser.close();
                    } catch (closeErr) {
                        console.error('Error closing browser:', closeErr);
                    }
                }
            }

            if (anyRelease) {
                continue;
            }
        }
    } catch (err) {
        console.error('Fatal error initializing watcher:', err);
    }
})();
