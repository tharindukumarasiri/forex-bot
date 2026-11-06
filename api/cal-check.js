require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');

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

    if (error) {
        console.error(`Error fetching previous ${type} rate:`, error);
        return null;
    }
    if (!data || data.length === 0) {
        return null;
    }

    return Number(data[0].rate);
}

// ==============================
// Discord
// ==============================

async function sendDiscordMessage(message) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message })
    });

    if (!res.ok) {
        console.error(`Discord webhook failed: HTTP ${res.status}`, await res.text());
    }
}

// ==============================
// Scrapers
// ==============================

const USER_AGENT = 'Mozilla/5.0';

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// QEF (CAL Quantitative Equity Fund)
// The CAL calculator page loads its prices from this JSON endpoint. `valuedate`
// is the investment start date; LATEST_PRICE is always the latest published
// price. A fund is left out when valuedate is on or after its latest price date
// (QEF is published with a lag), so use a date safely in the past.
async function getQEF() {
    const valueDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await fetchWithTimeout(
        `https://cal.lk/wp-admin/admin-ajax.php?action=getUTFundRates&valuedate=${valueDate}`,
        {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'application/json',
                'Referer': 'https://cal.lk/unittrust/calculator/?fund=QEF'
            }
        }
    );

    const body = await res.json();
    const fund = (body.UTMS_FUND || []).find(f => String(f.FUND).trim().toUpperCase() === 'QEF');
    const price = fund ? parseFloat(fund.LATEST_PRICE) : NaN;

    if (!Number.isFinite(price)) throw new Error('QEF not found in CAL response');
    return Number(price.toFixed(4));
}

// ASPI (CSE All Share Price Index)
// Primary source is the Colombo Stock Exchange's own API (used by cse.lk).
// TradingView's scanner (CSELK:ASI) is used as a fallback.
async function getASPIFromCSE() {
    const res = await fetchWithTimeout('https://www.cse.lk/api/aspiData', {
        method: 'POST',
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
            'Referer': 'https://www.cse.lk/'
        }
    });

    const body = await res.json();
    const value = Number(body?.value);

    if (!Number.isFinite(value) || value <= 0) throw new Error('ASPI value missing in CSE response');
    return value;
}

async function getASPIFromTradingView() {
    const res = await fetchWithTimeout(
        'https://scanner.tradingview.com/symbol?symbol=CSELK%3AASI&fields=close&no_404=true',
        { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } }
    );

    const body = await res.json();
    const value = Number(body?.close);

    if (!Number.isFinite(value) || value <= 0) throw new Error('ASPI value missing in TradingView response');
    return value;
}

async function getASPI() {
    let value;
    try {
        value = await getASPIFromCSE();
    } catch (error) {
        console.error('CSE ASPI source failed, trying TradingView:', error);
        value = await getASPIFromTradingView();
    }
    return Number(value.toFixed(2));
}

async function getSellingPrice() {
    const [aspi, qef] = await Promise.allSettled([getASPI(), getQEF()]);

    if (aspi.status === 'rejected') console.error('ASPI scraper error:', aspi.reason);
    if (qef.status === 'rejected') console.error('QEF scraper error:', qef.reason);

    const ASPI = aspi.status === 'fulfilled' ? aspi.value : null;
    const QEF = qef.status === 'fulfilled' ? qef.value : null;

    console.log('Extracted ASPI:', ASPI);
    console.log('Extracted QEF:', QEF);

    return { ASPI, QEF };
}

// ==============================
// Notify + persist
// ==============================

async function processRate(type, current, decimals = 4) {
    const previous = await getPreviousRate(type);

    if (previous !== null) {
        if (current > previous) {
            await sendDiscordMessage(
                `${type} has gone up: ${current} 🟢 (+${(current - previous).toFixed(decimals)})`
            );
        } else if (current < previous) {
            await sendDiscordMessage(
                `${type} has gone down: ${current} 🔴 (-${(previous - current).toFixed(decimals)})`
            );
        }
    } else {
        await sendDiscordMessage(`${type} rate ${current}`);
    }

    if (previous !== current) {
        await saveRateToDB(current, type);
    }
}

// ==============================
// API Handler (Vercel)
// ==============================

module.exports = async (req, res) => {

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    try {
        const currentRate = await getSellingPrice();

        // Handle each one on its own so one failing source does not block
        // the notification for the other. ASPI is sent first so it shows
        // above QEF in Discord.
        if (currentRate.ASPI !== null) await processRate('ASPI', currentRate.ASPI, 2);
        if (currentRate.QEF !== null) await processRate('QEF', currentRate.QEF, 4);

        const failed = Object.keys(currentRate).filter(k => currentRate[k] === null);
        if (failed.length > 0) {
            return res.status(500).json({ ...currentRate, error: `Failed to extract: ${failed.join(', ')}` });
        }

        return res.status(200).json(currentRate);

    } catch (error) {
        console.error('Manual trigger error:', error);
        return res.status(500).send('Failed to check rates.');
    }
};
