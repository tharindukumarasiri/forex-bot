require('dotenv').config();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_CAL;

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==============================
// Supabase Helpers
// ==============================

async function saveRateToDB(rate, type) {
    const { error } = await supabaseClient
        .from('cal_unit_trust_rates')
        .insert([{ type, rate, date: new Date() }]);

    if (error) {
        console.error('Error saving to Supabase:', error);
    } else {
        console.log(`Saved ${type} rate:`, rate);
    }
}

async function getPreviousRate(type) {
    const { data, error } = await supabaseClient
        .from('cal_unit_trust_rates')
        .select('rate')
        .eq('type', type)
        .order('date', { ascending: false })
        .limit(1);

    if (error || !data || data.length === 0) {
        return null;
    }

    return data[0].rate;
}

// ==============================
// Discord
// ==============================

async function sendDiscordMessage(message) {
    await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message })
    });
}

// ==============================
// Scraper
// ==============================

async function getSellingPrice() {
    let browser = null;

    try {
        console.log('Launching browser...');

        const options = {
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        };

        browser = await puppeteer.launch(options);
        const page = await browser.newPage();

        // =========================
        // QEF (CAL)
        // =========================
        await page.goto('https://cal.lk/unittrust/calculator/?fund=QEF', {
            timeout: 30000,
            waitUntil: 'networkidle2'
        });

        const calSelector = '.latest-price span';
        let QEF = null;

        const QEFExists = await page.$(calSelector) !== null;

        if (QEFExists) {
            const priceText = await page.evaluate(sel => {
                const el = document.querySelector(sel);
                return el ? el.textContent.trim() : null;
            }, calSelector);

            const match = priceText?.match(/(\d+\.\d+)/);
            if (match) QEF = parseFloat(match[1]);
        }

        // =========================
        // GF (NDB Wealth Growth & Income Fund)
        // =========================
        await page.goto('https://ndbwealth.com/', {
            timeout: 30000,
            waitUntil: 'networkidle2'
        });

        await page.waitForSelector('.p-row');

        let GF = await page.evaluate(() => {
            const rows = document.querySelectorAll('.p-row');

            for (let row of rows) {
                if (row.innerText.includes('NDB Wealth Growth & Income Fund')) {
                    const strongTags = row.querySelectorAll('strong');
                    if (strongTags.length >= 2) {
                        return parseFloat(strongTags[1].innerText.trim());
                    }
                }
            }

            return null;
        });

        console.log('Extracted QEF:', QEF);
        console.log('Extracted GF:', GF);

        return { QEF, GF };

    } catch (error) {
        console.error('Scraper error:', error);
        return { QEF: null, GF: null };
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed');
        }
    }
}

// ==============================
// API Handler (Vercel)
// ==============================

module.exports = async (req, res) => {

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    try {
        const currentRate = await getSellingPrice();

        if (!currentRate || currentRate.QEF === null || currentRate.GF === null) {
            return res.status(500).send('Failed to extract rates.');
        }

        // ======================
        // QEF Logic
        // ======================
        const previousQEFRate = await getPreviousRate('QEF');

        if (previousQEFRate !== null) {
            if (currentRate.QEF > previousQEFRate) {
                await sendDiscordMessage(
                    `QEF has gone up: ${currentRate.QEF} 🟢 (+${(currentRate.QEF - previousQEFRate).toFixed(4)})`
                );
            } else if (currentRate.QEF < previousQEFRate) {
                await sendDiscordMessage(
                    `QEF has gone down: ${currentRate.QEF} 🔴 (-${(previousQEFRate - currentRate.QEF).toFixed(4)})`
                );
            }
        } else {
            await sendDiscordMessage(`QEF rate ${currentRate.QEF}`);
        }

        if (previousQEFRate !== currentRate.QEF) {
            await saveRateToDB(currentRate.QEF, 'QEF');
        }

        // ======================
        // GF Logic
        // ======================
        const previousGFRate = await getPreviousRate('GF');

        if (previousGFRate !== null) {
            if (currentRate.GF > previousGFRate) {
                await sendDiscordMessage(
                    `GF has gone up: ${currentRate.GF} 🟢 (+${(currentRate.GF - previousGFRate).toFixed(4)})`
                );
            } else if (currentRate.GF < previousGFRate) {
                await sendDiscordMessage(
                    `GF has gone down: ${currentRate.GF} 🔴 (-${(previousGFRate - currentRate.GF).toFixed(4)})`
                );
            }
        } else {
            await sendDiscordMessage(`GF rate ${currentRate.GF}`);
        }

        if (previousGFRate !== currentRate.GF) {
            await saveRateToDB(currentRate.GF, 'GF');
        }

        return res.status(200).json({
            QEF: currentRate.QEF,
            GF: currentRate.GF
        });

    } catch (error) {
        console.error('Manual trigger error:', error);
        return res.status(500).send('Failed to check rates.');
    }
};
