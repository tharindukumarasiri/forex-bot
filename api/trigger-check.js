require('dotenv').config();
const fetch = require('node-fetch');
const supabase = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

async function getExchangeRate() {
    const res = await fetch('https://www.sampath.lk/api/exchange-rates', {
        headers: {
            'Referer': 'https://www.sampath.lk/rates-and-charges?activeTab=exchange-rates',
            'Origin': 'https://www.sampath.lk',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json',
        }
    });

    const body = await res.json();
    const usd = body.data.find(d => d.CurrCode === 'USD');
    const USD = usd ? parseFloat(usd.TTBUY) : null;

    console.log('Extracted USD T/T Buying:', USD);
    return { USD };
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
