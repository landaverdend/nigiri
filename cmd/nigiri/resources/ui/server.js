#!/usr/bin/env node
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '5050', 10);
const RPC_HOST = process.env.BITCOIN_RPC_HOST || 'localhost';
const RPC_PORT = parseInt(process.env.BITCOIN_RPC_PORT || '18443', 10);
const RPC_USER = process.env.BITCOIN_RPC_USER || 'admin1';
const RPC_PASS = process.env.BITCOIN_RPC_PASS || '123';
const ESPLORA_HOST = process.env.ESPLORA_HOST || 'localhost';
const ESPLORA_PORT = parseInt(process.env.ESPLORA_PORT || '3000', 10);
const ELECTRUM_HOST = process.env.ELECTRUM_HOST || 'localhost';
const ELECTRUM_PORT = parseInt(process.env.ELECTRUM_PORT || '50000', 10);

function rpc(method, params = [], wallet = undefined) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const walletPath = wallet !== undefined ? `/wallet/${wallet}` : '';
    const options = {
      hostname: RPC_HOST,
      port: RPC_PORT,
      path: walletPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64'),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(parsed.error);
          else resolve(parsed.result);
        } catch (e) {
          reject({ message: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function esplora(epath) {
  return new Promise((resolve, reject) => {
    const options = { hostname: ESPLORA_HOST, port: ESPLORA_PORT, path: epath, method: 'GET' };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function apiErr(res, e, status = 500) {
  const msg = e?.message || String(e);
  json(res, { error: msg }, status);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  let body = {};
  if (req.method === 'POST') {
    await new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => raw += c);
      req.on('end', () => { try { body = JSON.parse(raw); } catch {} resolve(); });
    });
  }

  try {
    if (pathname === '/api/info') {
      const [height, mempool, wallets] = await Promise.all([
        esplora('/blocks/tip/height'),
        esplora('/mempool'),
        rpc('listwallets'),
      ]);
      return json(res, { height, mempool, wallets });
    }

    if (pathname === '/api/address' && req.method === 'POST') {
      const { wallet = '', label = '' } = body;
      const address = await rpc('getnewaddress', [label], wallet);
      return json(res, { address });
    }

    if (pathname.startsWith('/api/address/') && req.method === 'GET') {
      const addr = pathname.split('/api/address/')[1];
      const data = await esplora(`/address/${addr}`);
      return json(res, data);
    }

    if (pathname === '/api/faucet' && req.method === 'POST') {
      const { address, amount = 1 } = body;
      if (!address) return apiErr(res, { message: 'address required' }, 400);
      const txid = await rpc('sendtoaddress', [address, parseFloat(amount)], '');
      const mineAddr = await rpc('getnewaddress', [], '');
      await rpc('generatetoaddress', [1, mineAddr], '');
      return json(res, { txid });
    }

    if (pathname === '/api/mine' && req.method === 'POST') {
      const { blocks = 1, wallet = '', address = '' } = body;
      let toAddress = address;
      if (!toAddress) {
        toAddress = await rpc('getnewaddress', [], wallet || '');
      }
      const result = await rpc('generatetoaddress', [parseInt(blocks), toAddress], wallet || '');
      return json(res, { blocks: result.length, hashes: result });
    }

    if (pathname === '/api/wallets') {
      const wallets = await rpc('listwallets');
      return json(res, { wallets });
    }

    if (pathname === '/api/wallet' && req.method === 'POST') {
      const { name } = body;
      if (!name) return apiErr(res, { message: 'name required' }, 400);
      const result = await rpc('createwallet', [name]);
      return json(res, result);
    }

    if (pathname.match(/^\/api\/wallet\/([^/]*)\/balance$/) && req.method === 'GET') {
      let wallet = decodeURIComponent(pathname.match(/^\/api\/wallet\/([^/]*)\/balance$/)[1]);
      if (wallet === 'default') wallet = '';
      const balance = await rpc('getbalance', ['*', 0, false], wallet);
      return json(res, { wallet, balance });
    }

    if (pathname.match(/^\/api\/wallet\/([^/]*)\/addresses$/) && req.method === 'GET') {
      let wallet = decodeURIComponent(pathname.match(/^\/api\/wallet\/([^/]*)\/addresses$/)[1]);
      if (wallet === 'default') wallet = '';
      const addrs = await rpc('listreceivedbyaddress', [0, true], wallet);
      return json(res, { wallet, addresses: addrs });
    }

    if (pathname === '/api/broadcast' && req.method === 'POST') {
      const { hex } = body;
      if (!hex) return apiErr(res, { message: 'hex required' }, 400);
      const txid = await rpc('sendrawtransaction', [hex]);
      return json(res, { txid });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    console.error(e);
    apiErr(res, e);
  }
});

// Electrum WebSocket bridge — ws://host:5050/electrum
const wss = new WebSocketServer({ server, path: '/electrum' });

wss.on('connection', (ws) => {
  const tcp = net.createConnection(ELECTRUM_PORT, ELECTRUM_HOST);
  let buf = '';

  tcp.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // hold onto any incomplete trailing line
    for (const line of lines) {
      if (line.trim()) ws.send(line);
    }
  });

  tcp.on('error', (e) => {
    ws.send(JSON.stringify({ error: e.message }));
    ws.close();
  });

  tcp.on('close', () => ws.close());

  ws.on('message', (msg) => tcp.write(msg + '\n'));
  ws.on('close', () => tcp.destroy());
});

server.listen(PORT, () => {
  console.log(`Nigiri UI running at http://localhost:${PORT}`);
  console.log(`Electrum WS bridge at ws://localhost:${PORT}/electrum`);
});
