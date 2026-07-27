import { bitgetApiRequest } from './bitgetService';
import fs from 'fs';

async function run() {
  const creds = JSON.parse(fs.readFileSync('./.env.live.json', 'utf8') || '{}');
  const apiKey = process.env.VITE_BITGET_API_KEY || creds.apiKey;
  const apiSecret = process.env.VITE_BITGET_API_SECRET || creds.apiSecret;
  const apiPassphrase = process.env.VITE_BITGET_API_PASSPHRASE || creds.apiPassphrase;

  if (apiKey) {
      const bitgetCreds = { apiKey, apiSecret, apiPassphrase };
      const posRes = await bitgetApiRequest('/api/v2/mix/position/all-position?productType=USDT-FUTURES', 'GET', null, bitgetCreds);
      console.log(JSON.stringify(posRes, null, 2));
      
      const planTypes = ['profit_plan', 'loss_plan', 'pos_profit', 'pos_loss', 'normal_plan', 'moving_plan'];
      for (const pt of planTypes) {
        const planRes = await bitgetApiRequest(`/api/v2/mix/order/orders-plan-pending?productType=USDT-FUTURES&planType=${pt}`, 'GET', null, bitgetCreds);
        console.log(`Plan ${pt}:`, JSON.stringify(planRes, null, 2));
      }
  }
}
run();
