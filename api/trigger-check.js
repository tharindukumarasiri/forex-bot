require('dotenv').config();
const fetch = require('node-fetch');
const pdf = require('pdf-parse');
const supabase = require('@supabase/supabase-js');
const cron = require('node-cron');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

async function getExchangeRate() {
    const url = 'https://www.hsbc.lk/content/dam/hsbc/lk/documents/tariffs/foreign-exchange-rates.pdf';
    const response = await fetch(url);

    const arrayBuffer = await response.arrayBuffer();

    const dataBuffer = Buffer.from(arrayBuffer);

    // Parse PDF with pdf-parse
    const data = await pdf(dataBuffer);

    // Extract Singapore Dollar exchange rate from the text
    const rawText = data.text;
    const matchUSD = rawText.match(/USD\s+(\d+\.\d{2})/);
    const matchSGD = rawText.match(/SGD\s+(\d+\.\d{2})/);

    return {
        USD: matchUSD ? parseFloat(matchUSD[1]) : null,
        SGD: matchSGD ? parseFloat(matchSGD[1]) : null,
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

        if (currentRate.USD !== null && currentRate.SGD !== null) {
            // For USD
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

            // For SGD
            const previousSGDRate = await getPreviousRate('SGD');
            if (previousSGDRate !== null) {
                if (currentRate.SGD > previousSGDRate) {
                    await sendDiscordMessage(`SGD rate has gone up: ${currentRate.SGD} 🟢 (+${(currentRate.SGD - previousSGDRate).toFixed(2)})`);
                } else if (currentRate.SGD < previousSGDRate) {
                    await sendDiscordMessage(`SGD rate has gone down: ${currentRate.SGD} 🔴 (-${(previousSGDRate - currentRate.SGD).toFixed(2)})`);
                }
            } else {
                await sendDiscordMessage(`SGD rate ${currentRate.SGD}`);
            }

            if (previousSGDRate !== currentRate.SGD)
                await saveRateToDB(currentRate.SGD, 'SGD');

        } else {
            console.error('Could not extract exchange rate.');
        }

        res.status(200).send('Exchange rate check triggered successfully.');
    } catch (error) {
        console.error('Error during manual trigger:', error);
        res.status(500).send('Failed to check exchange rates.');
    }
};
