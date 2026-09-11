const checkPrasads = require("./watcher");
const checkAllu = require("./allu-watcher");

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

(async function runner() {

    console.log("========== Seat Watcher Started ==========");

    while (true) {

        try {

            console.log("\nChecking Prasads...");
            await checkPrasads();

        } catch (err) {

            console.error("Prasads Error:", err);

        }

        try {

            console.log("\nChecking ALLU...");
            await checkAllu();

        } catch (err) {

            console.error("ALLU Error:", err);

        }

        console.log("\nRound completed.");
        console.log("Waiting 5 seconds...\n");

        await sleep(5000);

    }

})();