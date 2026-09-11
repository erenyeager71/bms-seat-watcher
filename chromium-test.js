const { chromium } = require("playwright");

(async () => {

    console.log("Launching Chromium...");

    const browser = await chromium.launch({
        headless: false
    });

    console.log("Chromium launched successfully.");

    const page = await browser.newPage();

    console.log("New page created.");

    await page.goto("https://example.com");

    console.log("Navigated to example.com successfully.");

    console.log("Waiting 15 seconds so you can see the window stays open...");

    await new Promise(resolve => setTimeout(resolve, 15000));

    await browser.close();

    console.log("Browser closed cleanly. Test PASSED.");

})().catch(err => {

    console.error("Test FAILED with error:", err);

});