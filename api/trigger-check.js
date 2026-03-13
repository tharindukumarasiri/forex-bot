require('dotenv').config();
const fetch = require('node-fetch');
const supabase = require('@supabase/supabase-js');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

async function getExchangeRate() {
    let browser = null;
    try {
        const options = {
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        };

        browser = await puppeteer.launch(options);
        const page = await browser.newPage();

        await page.goto('https://www.sampath.lk/rates-and-charges?activeTab=exchange-rates', {
            timeout: 30000,
            waitUntil: 'networkidle2'
        });

        await page.waitForSelector('table', { timeout: 15000 });

        const USD = await page.evaluate(() => {
            const rows = document.querySelectorAll('table tr');
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length > 0 && cells[0].textContent.trim().toUpperCase().includes('USD')) {
                    // T/T Buying is the first rate column (index 1)
                    const val = parseFloat(cells[1].textContent.trim().replace(/,/g, ''));
                    return isNaN(val) ? null : val;
                }
            }
            return null;
        });

        console.log('Extracted USD T/T Buying:', USD);
        return { USD };
    } catch (error) {
        console.error('Scraper error:', error);
        return { USD: null };
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed');
        }
    }
}

async function saveRateToDB(rate, currency) {
    const { data, error } = await supabaseClient
        .from('exchange_rates')
        .insert([{ currency: currency, rate, date: new Date() }]);

    if (error) {
        console.error('Error saving to Supabase:', error);
    } else {
        console.log('Saved rate to database:', rate);
    }
}

async function getPreviousRate(currency) {
    const { data, error } = await supabaseClient
        .from('exchange_rates')
        .select('rate')
        .eq('currency', currency)
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

module.exports = async (req, res) => {
    console.log('Manual trigger of exchange rate check.');

    // Set Cache-Control header to prevent caching
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    try {
        const currentRate = await getExchangeRate();

        if (currentRate.USD !== null) {
            const previousUSDRate = await getPreviousRate('USD');
            if (previousUSDRate !== null) {
                if (currentRate.USD > previousUSDRate) {
                    await sendDiscordMessage(`USD rate has gone up: ${currentRate.USD} 🟢 (+${(currentRate.USD - previousUSDRate).toFixed(2)})`);
                } else if (currentRate.USD < previousUSDRate) {
                    await sendDiscordMessage(`USD rate has gone down: ${currentRate.USD} 🔴 (-${(previousUSDRate - currentRate.USD).toFixed(2)})`);
                }
            } else {
                await sendDiscordMessage(`USD rate ${currentRate.USD}`);
            }

            if (previousUSDRate !== currentRate.USD)
                await saveRateToDB(currentRate.USD, 'USD');

        } else {
            console.error('Could not extract exchange rate.');
        }

        res.status(200).send({
            USD: currentRate.USD
        });
    } catch (error) {
        console.error('Error during manual trigger:', error);
        res.status(500).send('Failed to check exchange rates.');
    }
};
