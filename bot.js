import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const PORT       = process.env.PORT || 3000;
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const SOL_MINT   = 'So11111111111111111111111111111111111111112';

const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const recentlySeen = new Map();
function isDupe(wallet, mint) {
  const key = `${wallet}:${mint}`;
  const last = recentlySeen.get(key);
  if (last && Date.now() - last < 3_600_000) return true;
  recentlySeen.set(key, Date.now());
  return false;
}

// ---- Discord bot client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let alertChannel = null;

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  if (DISCORD_CHANNEL_ID) {
    try {
      alertChannel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      console.log('✅ Alert channel fetched');
    } catch (err) {
      console.error('Failed to fetch alert channel', err.message);
    }
  } else {
    console.warn('No DISCORD_CHANNEL_ID set');
  }
});

if (DISCORD_BOT_TOKEN) {
  client.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error('Discord login failed:', err.message);
  });
} else {
  console.error('No DISCORD_BOT_TOKEN set');
}
// ----------------------------

async function getTokenInfo(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data?.pairs?.find(p => p.chainId === 'solana') || data?.pairs?.[0];
    if (!pair) return null;
    return {
      name:          pair.baseToken?.name   || 'Unknown',
      symbol:        pair.baseToken?.symbol || '???',
      mcap:          pair.fdv,
      pairCreatedAt: pair.pairCreatedAt,
      imageUrl:      pair.info?.imageUrl   || null,
      venue:         pair.dexId            || null,
    };
  } catch { return null; }
}

async function getWalletProfile(address) {
  try {
    const url = `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=100`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const txs = await res.json();
    if (!Array.isArray(txs) || txs.length === 0)
      return { firstTxTimestamp: null, lastTxTimestamp: null, txCount: 0, fundedStr: '—', solBalance: null, dormantDays: null };

    const newest = txs[0].timestamp * 1000;
    const oldest = txs[txs.length - 1].timestamp * 1000;

    let fundedStr = '—';
    for (let i = txs.length - 1; i >= 0; i--) {
      const inbound = txs[i].nativeTransfers?.find(t => t.toUserAccount === address && t.amount > 0);
      if (inbound) {
        const daysAgo = Math.floor((Date.now() - txs[i].timestamp * 1000) / 86_400_000);
        fundedStr = `${daysAgo}d ago`;
        break;
      }
    }

    let solBalance = null;
    try {
      const balRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
      });
      const balData = await balRes.json();
      if (balData?.result?.value != null) solBalance = balData.result.value / 1e9;
    } catch {}

    return {
      firstTxTimestamp: oldest,
      lastTxTimestamp:  newest,
      txCount:          txs.length,
      fundedStr,
      solBalance,
      dormantDays: (Date.now() - newest) / 86_400_000,
    };
  } catch { return null; }
}

function fmtMcap(n) {
  if (!n && n !== 0) return 'N/A';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function shortAddr(addr) { return `${addr.slice(0,4)}\u2026${addr.slice(-4)}`; }

function buildEmbed({ wallet, token, mint, swapSol, profile }) {
  const wAgeDays = profile?.firstTxTimestamp
    ? Math.floor((Date.now() - profile.firstTxTimestamp) / 86_400_000) : null;
  const tAgeDays = token?.pairCreatedAt
    ? Math.floor((Date.now() - token.pairCreatedAt) / 86_400_000) : null;

  const tags = [];
  if (token?.mcap && token.mcap < 500_000) tags.push('LOW MC');
  if (swapSol && parseFloat(swapSol) >= 10) tags.push('BIG BUY');
  if (wAgeDays !== null && wAgeDays <= 7)   tags.push('FRESH WALLET');

  const solBal = profile?.solBalance != null ? `${profile.solBalance.toFixed(2)} SOL` : 'N/A';

  return new EmbedBuilder()
    .setColor(0x00e5ff)
    .setAuthor({ name: tags.join(' · ') || 'TEST SIGNAL' })
    .setTitle(`🐋 ${token?.name || shortAddr(mint)} · ${swapSol ? swapSol + ' SOL' : 'N/A'}`)
    .setThumbnail(token?.imageUrl || null)
    .addFields(
      { name: '🪙 Token', value: '\u200b', inline: false },
      { name: 'MC',       value: fmtMcap(token?.mcap),                      inline: true },
      { name: 'Age',      value: tAgeDays != null ? `${tAgeDays}d` : 'N/A', inline: true },
      { name: 'Contract', value: `\`${mint}\``,                              inline: false },
      { name: '👛 Wallet', value:
          `[👤 ${shortAddr(wallet)}](https://solscan.io/account/${wallet})\n` +
          `Age ${wAgeDays != null ? wAgeDays + 'd' : '?'} · Tx ${profile?.txCount ?? '?'}\n` +
          `Funded ${profile?.fundedStr ?? '—'}`,
        inline: false },
      { name: 'SOL Balance', value: solBal,                                  inline: true },
      { name: 'Buy Amount',  value: swapSol ? `${swapSol} SOL` : 'N/A',     inline: true },
      { name: 'Dormant',     value: profile?.dormantDays != null ? `${Math.round(profile.dormantDays)}d` : '—', inline: true },
    )
    .setFooter({ text: `${token?.venue || 'pump.fun'} · TEST MODE · ${new Date().toUTCString()}` })
    .setTimestamp();
}

function buildComponents(mint, sig) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 5, label: 'Solscan', url: `https://solscan.io/tx/${sig}` },
      { type: 2, style: 5, label: 'Axiom',   url: `https://axiom.trade/t/${mint}` },
    ],
  }];
}

async function handleHeliusEvent(events) {
  if (!Array.isArray(events)) events = [events];
  console.log('[HANDLE] events length', events.length);

  for (const event of events) {
    if (event.type !== 'SWAP') {
      console.log('[HANDLE] skip non-SWAP type', event.type);
      continue;
    }

    const wallet = event.feePayer;
    const sig    = event.signature;
    if (!wallet) {
      console.log('[HANDLE] missing wallet, skipping');
      continue;
    }

    let mint = null;
    let swapSol = null;
    const swap = event.swap;

    if (swap?.tokenInputs?.length && swap?.tokenOutputs?.length) {
      const outMint = swap.tokenOutputs[0]?.mint;
      const inMint  = swap.tokenInputs[0]?.mint;
      if (outMint && outMint !== SOL_MINT)    mint = outMint;
      else if (inMint && inMint !== SOL_MINT) mint = inMint;
      const nativeDelta = event.accountData?.find(a => a.account === wallet)?.nativeBalanceChange;
      if (nativeDelta) swapSol = Math.abs(nativeDelta / 1e9).toFixed(3);
    }

    if (!mint) {
      console.log('[HANDLE] no mint found for', wallet.slice(0,8), sig?.slice(0,8));
      continue;
    }
    if (isDupe(wallet, mint)) {
      console.log('[HANDLE] dupe skip for', wallet.slice(0,8), mint.slice(0,8));
      continue;
    }

    console.log(`[TEST] wallet=${wallet.slice(0,8)}… mint=${mint.slice(0,8)}…`);

    const profile    = await getWalletProfile(wallet);
    const token      = await getTokenInfo(mint);
    const components = buildComponents(mint, sig);
    const embed      = buildEmbed({ wallet, token, mint, swapSol, profile });

    console.log('[DISCORD] about to send alert');
    if (alertChannel) {
      await alertChannel.send({ embeds: [embed], components }).catch(console.error);
      console.log('[TEST] alert sent via bot!');
    } else {
      console.warn('[DISCORD] No alertChannel set, cannot send');
    }
  }
}

// ---- Enhanced WebSocket listener ----
function startWs() {
  if (!HELIUS_KEY) {
    console.error('No HELIUS_API_KEY set in env, cannot start WS');
    return;
  }

  const wsUrl = process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  console.log('[WS] connecting to Helius Enhanced WS:', wsUrl);

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[WS] open, sending transactionSubscribe');

    const sub = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        {
          failed: false,
          vote: false,
          accountInclude: [
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
            'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
            'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
          ],
        },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'full',
        },
      ],
    };

    ws.send(JSON.stringify(sub));
    console.log('[WS] subscription payload sent');
  });

  ws.on('message', async (raw) => {
    try {
      const text = raw.toString();
      console.log('[WS] raw message:', text.slice(0, 300));

      const msg = JSON.parse(text);

      if (msg.method !== 'transactionNotification') {
        return;
      }

      console.log('[WS] tx notification received');

      const result = msg.params?.result;
      if (!result) return;

      const tx   = result.transaction;
      const meta = result.meta;
      if (!tx || !meta) return;

      const feePayer =
        tx.message?.accountKeys?.[0]?.pubkey || tx.message?.accountKeys?.[0];
      const signature = tx.signatures?.[0];

      if (!feePayer || !signature) return;

      let nativeChange = null;
      if (Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
        const pre  = meta.preBalances[0];
        const post = meta.postBalances[0];
        if (typeof pre === 'number' && typeof post === 'number') {
          nativeChange = post - pre;
        }
      }

      let mint = null;
      const tokenBalances = [
        ...(meta.preTokenBalances || []),
        ...(meta.postTokenBalances || []),
      ];
      console.log('[WS] tokenBalances length', tokenBalances.length);
      const nonSol = tokenBalances.find(b => b.mint && b.mint !== SOL_MINT);
      if (nonSol) mint = nonSol.mint;
      console.log('[WS] derived mint', mint);

      if (!mint) return;

      const eventShape = {
        type: 'SWAP',
        feePayer,
        signature,
        swap: {
          tokenInputs: [],
          tokenOutputs: [{ mint }],
        },
        accountData:
          nativeChange != null
            ? [{ account: feePayer, nativeBalanceChange: nativeChange }]
            : [],
      };

      console.log('[WS] emitting event', {
        feePayer: feePayer.slice(0, 8),
        mint: mint.slice(0, 8),
      });

      await handleHeliusEvent(eventShape);
    } catch (err) {
      console.error('[WS] message error', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] error', err.message);
  });

  ws.on('close', (code, reason) => {
    console.warn('[WS] closed', code, reason?.toString());
    setTimeout(() => {
      console.log('[WS] reconnecting…');
      startWs();
    }, 3000);
  });
}
// -------------------------------------

const app = express();
app.use(express.json());
app.get('/', (_req, res) => res.json({ status: 'ok', mode: 'TEST — no filters' }));
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try { await handleHeliusEvent(req.body); }
  catch (err) { console.error('[ERROR]', err.message); }
});

app.listen(PORT, () => {
  console.log(`✅ TEST MODE — no filters, every swap fires`);
  console.log(`   Discord bot token: ${DISCORD_BOT_TOKEN ? '✓' : '✗ NOT SET'}`);
  console.log(`   Discord channel:   ${DISCORD_CHANNEL_ID || '✗ NOT SET'}`);
  startWs();
});
