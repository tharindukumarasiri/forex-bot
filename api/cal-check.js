require('dotenv').config();
const fetch = require('node-fetch');
const supabase = require('@supabase/supabase-js');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_CAL;

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

async function saveRateToDB(rate, type) {
    const { data, error } = await supabaseClient
        .from('cal_unit_trust_rates')
        .insert([{ type: type, rate, date: new Date() }]);

    if (error) {
        console.error('Error saving to Supabase:', error);
    } else {
        console.log('Saved rate to database:', rate);
    }
}

async function getPreviousRate(type) {
    const { data, error } = await supabaseClient
        .from('cal_unit_trust_rates')
        .select('rate')
        .eq('type', type)
        .order('date', { ascending: false })
        .limit(1);

    if (error || data.length === 0) {
        console.error('Error fetching previous rate:', error);
        return null;
    }

    return data[0].rate;
}

async function sendDiscordMessage(message) {
    await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message })
    });
}

async function getSellingPrice() {
    let browser = null;

    try {
        console.log('Launching headless browser...');
        // Configure browser for different environments
        const options = {
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        };

        browser = await puppeteer.launch(options);

        const page = await browser.newPage();

        // Set a timeout for the navigation
        await page.goto('https://cal.lk/unittrust/calculator/?fund=QEF', {
            timeout: 30000,
            waitUntil: 'networkidle2'  // Wait until network is idle
        });

        // Selector to find the price
        const selector = '.latest-price span'

        let quantitativeEquityFundPrice = null;

        // Check if selector exists
        const QEFExists = await page.$(selector) !== null;

        if (QEFExists) {
            // Extract the text content
            const priceText = await page.evaluate((sel) => {
                const element = document.querySelector(sel);
                return element ? element.textContent.trim() : null;
            }, selector);

            // Extract number from text
            if (priceText) {
                const match = priceText.match(/(\d+\.\d+)/);
                if (match && match[1]) {
                    quantitativeEquityFundPrice = parseFloat(match[1]);
                    console.log(`Extracted price: ${quantitativeEquityFundPrice}`);
                }
            }
        }

        // NOTE: Balanced fund start here >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

        // Set a timeout for the navigation
        await page.goto('https://cal.lk/unittrust/calculator/?fund=BF', {
            timeout: 30000,
            waitUntil: 'networkidle2'  // Wait until network is idle
        });

        let balancedFundFundPrice = null;

        // Check if selector exists
        const BFExists = await page.$(selector) !== null;

        if (BFExists) {
            // Extract the text content
            const priceText = await page.evaluate((sel) => {
                const element = document.querySelector(sel);
                return element ? element.textContent.trim() : null;
            }, selector);

            // Extract number from text
            if (priceText) {
                const match = priceText.match(/(\d+\.\d+)/);
                if (match && match[1]) {
                    balancedFundFundPrice = parseFloat(match[1]);
                    console.log(`Extracted price: ${balancedFundFundPrice}`);
                }
            }
        }

        return {
            QEF: quantitativeEquityFundPrice,
            BF: balancedFundFundPrice,
        }
    } catch (error) {
        console.error('Error in puppeteer scraper:', error);
        return null;
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed');
        }
    }
}

module.exports = async (req, res) => {
    // Set Cache-Control header to prevent caching
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    try {
        const currentRate = await getSellingPrice();

        if (currentRate.QEF !== null && currentRate.BF !== null) {
            // For Quantitative Equity Fund
            const previousQEFRate = await getPreviousRate('QEF');
            if (previousQEFRate !== null) {
                if (currentRate.QEF > previousQEFRate) {
                    await sendDiscordMessage(`QEF has gone up: ${currentRate.QEF} 🟢 (+${(currentRate.QEF - previousQEFRate).toFixed(2)})`);
                } else if (currentRate.QEF < previousQEFRate) {
                    await sendDiscordMessage(`QEF has gone down: ${currentRate.QEF} 🔴 (-${(previousQEFRate - currentRate.QEF).toFixed(2)})`);
                }
            } else {
                await sendDiscordMessage(`QEF rate ${currentRate.QEF}`);
            }

            if (previousQEFRate !== currentRate.QEF)
                await saveRateToDB(currentRate.QEF, 'QEF');

            // For Balanced fund
            const previousBFRate = await getPreviousRate('BF');
            if (previousBFRate !== null) {
                if (currentRate.BF > previousBFRate) {
                    await sendDiscordMessage(`BF has gone up: ${currentRate.BF} 🟢 (+${(currentRate.BF - previousBFRate).toFixed(2)})`);
                } else if (currentRate.BF < previousBFRate) {
                    await sendDiscordMessage(`BF has gone down: ${currentRate.BF} 🔴 (-${(previousBFRate - currentRate.BF).toFixed(2)})`);
                }
            } else {
                await sendDiscordMessage(`SGD rate ${currentRate.BF}`);
            }

            if (previousBFRate !== currentRate.BF)
                await saveRateToDB(currentRate.BF, 'BF');

        } else {
            console.error('Could not extract exchange rate.');
        }

        res.status(200).send({
            QEF: currentRate.QEF,
            BF: currentRate.BF
        });
    } catch (error) {
        console.error('Error during manual trigger:', error);
        res.status(500).send('Failed to check exchange rates.');
    }
};