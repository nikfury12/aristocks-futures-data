import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const OUTPUT = resolve('data/futures.json');
const COLUMNS = ['SECID', 'SHORTNAME', 'LASTTRADEDATE', 'MINSTEP', 'STEPPRICE', 'INITIALMARGIN', 'PREVSETTLEPRICE', 'ASSETCODE'];
const ENDPOINT = 'https://iss.moex.com/iss/engines/futures/markets/forts/boards/RFUD/securities.json';
const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;

async function fetchPage(start, attempt = 1) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('iss.meta', 'off');
  url.searchParams.set('iss.only', 'securities,securities.cursor');
  url.searchParams.set('securities.columns', COLUMNS.join(','));
  url.searchParams.set('start', String(start));
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Aristocks futures calculator/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`MOEX returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise(resolvePromise => setTimeout(resolvePromise, attempt * 1_000));
    return fetchPage(start, attempt + 1);
  }
}

function rowsToObjects(block) {
  const positions = Object.fromEntries(block.columns.map((column, index) => [column, index]));
  return block.data.map(row => Object.fromEntries(COLUMNS.map(column => [column, row[positions[column]]])));
}

async function loadAllRows() {
  const firstPayload = await fetchPage(0);
  if (!firstPayload.securities?.columns || !Array.isArray(firstPayload.securities.data)) throw new Error('MOEX response has no securities table');
  const firstPage = rowsToObjects(firstPayload.securities);
  if (!firstPage.length) return [];

  const rows = [...firstPage];
  const pageSize = firstPage.length;
  const batchSize = 8;
  const maxPages = 2_000;
  const signatures = new Set([firstPage.map(row => row.SECID).join('|')]);

  for (let pageIndex = 1; pageIndex < maxPages; pageIndex += batchSize) {
    const indexes = Array.from({ length: Math.min(batchSize, maxPages - pageIndex) }, (_, offset) => pageIndex + offset);
    const payloads = await Promise.all(indexes.map(index => fetchPage(index * pageSize)));
    let reachedEnd = false;

    for (const payload of payloads) {
      if (!payload.securities?.columns || !Array.isArray(payload.securities.data)) throw new Error('MOEX response has no securities table');
      const page = rowsToObjects(payload.securities);
      if (!page.length) { reachedEnd = true; continue; }
      const signature = page.map(row => row.SECID).join('|');
      if (signatures.has(signature)) throw new Error('MOEX pagination returned a repeated page');
      signatures.add(signature);
      rows.push(...page);
      if (page.length < pageSize) reachedEnd = true;
    }

    if (reachedEnd) return rows;
  }

  throw new Error('MOEX pagination safety limit exceeded');
}

function normalize(rows) {
  const today = new Date().toISOString().slice(0, 10);
  const unique = new Map();
  for (const row of rows) {
    const contract = {
      secid: String(row.SECID || '').trim(),
      name: String(row.SHORTNAME || row.SECID || '').trim(),
      assetCode: String(row.ASSETCODE || '').trim(),
      expiry: String(row.LASTTRADEDATE || '').slice(0, 10),
      minStep: asNumber(row.MINSTEP),
      stepPrice: asNumber(row.STEPPRICE),
      margin: asNumber(row.INITIALMARGIN),
      price: asNumber(row.PREVSETTLEPRICE),
    };
    if (!contract.secid || !contract.expiry || contract.expiry < today) continue;
    if (contract.minStep <= 0 || contract.stepPrice <= 0) continue;
    unique.set(contract.secid, contract);
  }
  return [...unique.values()].sort((a, b) => a.expiry.localeCompare(b.expiry, 'ru') || a.secid.localeCompare(b.secid, 'ru'));
}

async function previousDocument() {
  try { return JSON.parse(await readFile(OUTPUT, 'utf8')); }
  catch { return null; }
}

const contracts = normalize(await loadAllRows());
if (contracts.length < 20) throw new Error(`Refusing to replace data: only ${contracts.length} valid contracts received`);
const previous = await previousDocument();
const changed = JSON.stringify(previous?.contracts || []) !== JSON.stringify(contracts);
const previousTime = new Date(previous?.updatedAt || 0).getTime();
const heartbeatDue = !Number.isFinite(previousTime) || Date.now() - previousTime >= 20 * 60 * 60 * 1000;
if (!changed && !heartbeatDue) {
  console.log(`${contracts.length} contracts verified; file is already current.`);
  process.exit(0);
}
const document = { source: 'MOEX ISS', updatedAt: new Date().toISOString(), count: contracts.length, contracts };
await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`${contracts.length} contracts written; data ${changed ? 'changed' : 'verified'}.`);
