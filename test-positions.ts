import { fetchLiveOpenPositions } from './bitgetService';

const apiKey = process.env.BITGET_LIVE_API_KEY || '';
const apiSecret = process.env.BITGET_LIVE_API_SECRET || '';
const passphrase = process.env.BITGET_LIVE_PASSPHRASE || '';

console.log("Credentials configured:", !!apiKey, !!apiSecret, !!passphrase);

async function run() {
  if (!apiKey) return;
  const res = await fetchLiveOpenPositions({ apiKey, apiSecret, passphrase });
  console.log("Positions Result:", JSON.stringify(res, null, 2));
}

run();
