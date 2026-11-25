// commands.js - LUMI command handler (single file, Baileys, CommonJS)
// Rebuilt from the full Lumi project. Owner: Divine.
//
// Install:  npm i @whiskeysockets/baileys sharp
// Optional: npm i wa-sticker-formatter ffmpeg-static   (video stickers, .tomp3, animated .toimg)
//
// Wire it into your messages.upsert handler:
//
//   const lumi = require('./commands');
//   lumi.configure({
//     generate: async (messages) => ({ text: '...' }), // your AI call (used by .recap), optional
//     clearMemory: (userNum) => {},                    // wipe stored AI history (used by .clear), optional
//     onAiChat: (userNum) => {},                       // called after each AI chat, optional
//   });
//   sock.ev.on('messages.upsert', async ({ messages }) => {
//     const msg = messages[0];
//     if (await lumi.handleCommand(sock, msg)) return;          // command, AFK, sleep or Divine protection
//     if (lumi.shouldChat(sock, msg)) { /* your existing AI reply code */ }
//   });
//
// Env (all optional): PREFIX, OWNER_NAME, OWNER_NUMBER, OWNER_SHOW_NUMBER, CLAIM_PASSPHRASE,
// PROTECTED_CONTACT_ID, PROTECTED_ENABLED, PROTECTED_COOLDOWN_MS, STICKER_PACK, STICKER_AUTHOR,
// MUSIC_COUNTRY, COBALT_API_URL, COBALT_API_KEY, DL_MAX_MB, PERSONALITY (warm|maki|calm), DATA_DIR.
// Personality of the AI chat itself lives in personality.js / annoy.js of the full project; this file only
// uses it for the menu and .about text.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');
const { downloadMediaMessage, downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');

// ---------- config ----------

const digits = (v) => String(v || '').replace(/\D/g, '');
const idList = (v) => String(v || '').split(',').map(digits).filter(Boolean);
const flag = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const CONFIG = {
  botName: 'Lumi',
  version: '1.1.0',
  prefix: process.env.PREFIX || '.',
  dataDir: process.env.DATA_DIR || 'data',
  claimPassphrase: process.env.CLAIM_PASSPHRASE || '',
  personality: (process.env.PERSONALITY || 'warm').toLowerCase(),
  ownerName: process.env.OWNER_NAME || 'Divine',
  ownerIds: idList(process.env.OWNER_NUMBER || '2347075369608'),
  showOwnerNumber: flag(process.env.OWNER_SHOW_NUMBER, false),
  protectedIds: idList(process.env.PROTECTED_CONTACT_ID),
  protectedEnabled: flag(process.env.PROTECTED_ENABLED, true),
  protectedCooldownMs: parseInt(process.env.PROTECTED_COOLDOWN_MS, 10) || 30000,
  stickerPack: process.env.STICKER_PACK || 'Lumi',
  stickerAuthor: process.env.STICKER_AUTHOR || 'Made by Lumi',
  musicCountry: process.env.MUSIC_COUNTRY || 'US',
  cobaltUrl: (process.env.COBALT_API_URL || '').trim(),
  cobaltKey: (process.env.COBALT_API_KEY || '').trim(),
  dlMaxBytes: (parseInt(process.env.DL_MAX_MB, 10) || 60) * 1024 * 1024,
};
const label = () => (CONFIG.personality === 'calm' ? 'Nonchalant.' : CONFIG.personality === 'maki' ? 'Blunt & nonchalant.' : 'Warm. Bites back.');

// Hooks the host app can plug in (all optional).
const hooks = { generate: null, clearMemory: null, onAiChat: null };
function configure(h = {}) { Object.assign(hooks, h); }

// ---------- tiny json store ----------

const NOOP_LOG = { level: 'silent', child() { return NOOP_LOG; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
const warn = (...a) => console.warn('[lumi]', ...a);

const STORE_FILE = path.join(CONFIG.dataDir, 'commands.json');
const store = { aiOff: {}, protectEnabled: null, claimed: [], protectAlias: [], subOwners: [], prefix: null, afk: {}, sleeping: {}, affinity: {}, wins: {}, voiceName: null, jail: {}, stickers: {} };
try {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  Object.assign(store, JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')));
} catch (_) { /* first run */ }
let saveTimer = null;
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) { warn('could not save settings:', e.message); }
}
function save() { if (!saveTimer) { saveTimer = setTimeout(flush, 1500); saveTimer.unref && saveTimer.unref(); } }
process.on('exit', () => { try { if (saveTimer) flush(); } catch (_) {} });

// ---------- settings (owners, prefix, AI switch, sleep, AFK, affinity) ----------

const uniq = (a) => [...new Set(a)];
const numberOf = (jid) => String(jid || '').split('@')[0].split(':')[0];

const S = {
  prefix: () => store.prefix || CONFIG.prefix,
  setPrefix(p) { store.prefix = p && p !== CONFIG.prefix ? p : null; save(); },
  isAiOn: (chat) => !store.aiOff[chat],
  setAi(chat, on) { if (on) delete store.aiOff[chat]; else store.aiOff[chat] = true; save(); },
  isProtectOn: () => (store.protectEnabled === null ? CONFIG.protectedEnabled : store.protectEnabled),
  setProtect(on) { store.protectEnabled = Boolean(on); save(); },
  isMainOwner: (n) => CONFIG.ownerIds.includes(n) || store.claimed.includes(n),
  isSubOwner: (n) => store.subOwners.includes(n),
  isOwner: (n) => S.isMainOwner(n) || S.isSubOwner(n),
  addSubOwners(nums) {
    const before = store.subOwners.length;
    store.subOwners = uniq([...store.subOwners, ...nums.filter((n) => n && !S.isMainOwner(n))]);
    if (store.subOwners.length !== before) save();
    return store.subOwners.length - before;
  },
  removeSubOwners(nums) {
    const before = store.subOwners.length;
    store.subOwners = store.subOwners.filter((n) => !nums.includes(n));
    if (store.subOwners.length !== before) save();
    return before - store.subOwners.length;
  },
  addClaimed(nums) {
    const before = store.claimed.length;
    store.claimed = uniq([...store.claimed, ...nums.filter(Boolean)]);
    if (store.claimed.length !== before) save();
    return store.claimed.length !== before;
  },
  clearClaimed() { store.claimed = []; store.protectAlias = []; save(); },
  addProtectAlias(nums) {
    const before = store.protectAlias.length;
    store.protectAlias = uniq([...store.protectAlias, ...nums.filter(Boolean)]);
    if (store.protectAlias.length !== before) save();
  },
  protectedIds: () => uniq([...CONFIG.protectedIds, ...store.claimed, ...store.protectAlias]),
  isAsleep: (chat) => Boolean(store.sleeping[chat]),
  setSleep(chat, on) { if (on) store.sleeping[chat] = true; else delete store.sleeping[chat]; save(); },
  getAfk: (n) => store.afk[n] || null,
  setAfk(n, info) { store.afk[n] = info; save(); },
  clearAfk(n) { delete store.afk[n]; save(); },
};

// ---------- affinity + game wins ----------

const LEVELS = [[0, 'stranger'], [10, 'tolerated'], [40, 'familiar'], [100, 'trusted'], [200, 'favorite']];
const lastGain = new Map();
function getAffinity(num) {
  const pts = store.affinity[num] || 0;
  let cur = LEVELS[0], next = null;
  for (let i = 0; i < LEVELS.length; i++) if (pts >= LEVELS[i][0]) { cur = LEVELS[i]; next = LEVELS[i + 1] || null; }
  return { pts, level: cur[1], next: next ? { level: next[1], need: next[0] - pts } : null };
}
function gainAffinity(num, n = 1) { // +1 per AI conversation, max once per 30 s per person
  if (!num) return 0;
  const now = Date.now();
  if (now - (lastGain.get(num) || 0) < 30000) return getAffinity(num).pts;
  lastGain.set(num, now);
  store.affinity[num] = Math.min(1000, (store.affinity[num] || 0) + n);
  save();
  return store.affinity[num];
}
function resetAffinity(nums) {
  let c = 0;
  for (const n of nums) { lastGain.delete(n); if (store.affinity[n] !== undefined) { delete store.affinity[n]; c++; } }
  if (c) save();
  return c;
}
function resetAllAffinity() { const c = Object.keys(store.affinity).length; store.affinity = {}; lastGain.clear(); save(); return c; }
function addWin(num, name) {
  if (!num) return;
  const w = store.wins[num] || (store.wins[num] = { n: 0, name: '' });
  w.n += 1;
  if (name) w.name = name;
  save();
}
const topWins = (k = 10) => Object.entries(store.wins).map(([num, w]) => ({ num, name: w.name, n: w.n })).sort((a, b) => b.n - a.n).slice(0, k);

// ---------- small helpers ----------

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m ${sec % 60}s`;
}

// Peel off wrappers (disappearing messages, view-once, etc.)
function unwrap(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    const inner = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage;
    if (!inner) break;
    m = inner.message;
  }
  return m;
}
const getText = (m) => (m ? m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '' : '');
function getContext(m) {
  if (!m) return null;
  for (const v of Object.values(m)) if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  return null;
}
function findMedia(msg, kinds) {
  const pickKind = (m) => { for (const k of kinds) if (m?.[`${k}Message`]) return { kind: k, node: m[`${k}Message`] }; return null; };
  const m = unwrap(msg.message);
  const own = pickKind(m);
  if (own) return { ...own, source: { key: msg.key, message: msg.message } };
  const ci = getContext(m);
  if (ci?.quotedMessage) {
    const found = pickKind(unwrap(ci.quotedMessage));
    if (found) return { ...found, source: { key: { remoteJid: msg.key.remoteJid, id: ci.stanzaId, participant: ci.participant }, message: ci.quotedMessage } };
  }
  return null;
}
const downloadMedia = (sock, source) => downloadMediaMessage(source, 'buffer', {}, { logger: NOOP_LOG, reuploadRequest: sock.updateMediaMessage });

// Every id WhatsApp gives us for this sender (phone number and/or hidden LID).
function senderIds(msg) {
  const k = msg.key;
  return [k.participant, k.participantAlt, k.participantPn, k.remoteJidAlt, k.remoteJid]
    .filter((j) => j && (j.endsWith('@s.whatsapp.net') || j.endsWith('@lid'))).map(numberOf);
}
// Who does a command point at? @mentions, else the replied-to person, plus typed numbers.
function targetNumbers(ctx) {
  const out = new Set(ctx.mentioned.map(numberOf));
  ctx.args.map((a) => a.replace(/\D/g, '')).filter((x) => x.length >= 7 && x.length <= 15).forEach((x) => out.add(x));
  if (!out.size && ctx.ctxInfo?.participant) out.add(numberOf(ctx.ctxInfo.participant));
  return [...out].filter(Boolean);
}
// "5s", "2m", "1h" (or "5" = seconds). Between 1 second and 6 hours.
function parseDuration(a) {
  const m = /^(\d+)\s*(s|sec|m|min|h|hr)?$/i.exec(String(a || '').trim());
  if (!m) return null;
  const unit = (m[2] || 's').toLowerCase();
  const ms = parseInt(m[1], 10) * (unit.startsWith('h') ? 3600000 : unit.startsWith('m') ? 60000 : 1000);
  return ms >= 1000 && ms <= 6 * 3600000 ? ms : null;
}

async function groupInfo(sock, jid) {
  const meta = await sock.groupMetadata(jid);
  const nums = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf);
  const admins = new Set(meta.participants.filter((p) => p.admin).flatMap(nums));
  const botNumbers = [sock.user?.id, sock.user?.lid].filter(Boolean).map(numberOf);
  return { meta, admins, botNumbers, botIsAdmin: botNumbers.some((b) => admins.has(b)) };
}
async function adminGuard(ctx, { needBotAdmin = true } = {}) {
  if (!ctx.isGroup) { await ctx.reply('Groups only.'); return null; }
  const info = await groupInfo(ctx.sock, ctx.jid);
  if (!ctx.isOwner && !info.admins.has(ctx.senderNum)) { await ctx.reply('Admins only.'); return null; }
  if (needBotAdmin && !info.botIsAdmin) { await ctx.reply("Make me an admin first. I can't do that otherwise."); return null; }
  return info;
}

// promote / demote share everything except the action and the wording.
async function updateMembers(ctx, action, done, usage) {
  const info = await adminGuard(ctx);
  if (!info) return;
  const targets = uniq(ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []));
  if (!targets.length) return ctx.reply(usage);
  if (action === 'demote') {
    const prot = S.protectedIds();
    if (targets.some((j) => { const n = numberOf(j); return info.botNumbers.includes(n) || S.isOwner(n) || prot.includes(n); })) {
      return ctx.reply('Not him. Not me either. Pick someone else.');
    }
  }
  const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, action);
  const failed = (res || []).filter((r) => String(r.status) !== '200');
  return ctx.reply(failed.length ? "Couldn't do it for everyone. WhatsApp said no." : done);
}
const groupSetting = (name, value, done) => ({
  name, category: 'GROUP TOOLS', menu: [name],
  run: async (ctx) => {
    if (!(await adminGuard(ctx))) return;
    await ctx.sock.groupSettingUpdate(ctx.jid, value);
    return ctx.reply(done);
  },
});

async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, as = 'json' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
    return as === 'text' ? res.text() : res.json();
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('timeout'); t.status = 'timeout'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

// ---------- ffmpeg (optional) ----------

let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) { try { ffmpegPath = require('ffmpeg-static'); } catch (_) {} }
if (!ffmpegPath) { try { if (require('child_process').spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0) ffmpegPath = 'ffmpeg'; } catch (_) {} }
if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;

async function ffmpeg(buf, inName, outName, args) {
  if (!ffmpegPath) throw new Error('ffmpeg unavailable');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lumi-'));
  const inp = path.join(dir, inName), out = path.join(dir, outName);
  try {
    await fs.promises.writeFile(inp, buf);
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-y', '-i', inp, ...args, out]);
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
    });
    return await fs.promises.readFile(out);
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}
const gifToMp4 = (buf) => ffmpeg(buf, 'in.gif', 'out.mp4', ['-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']);
const toVoiceNote = (buf) => ffmpeg(buf, 'in.bin', 'out.ogg', ['-vn', '-af', 'highpass=f=70,loudnorm=I=-18:TP=-2:LRA=11', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '40k', '-application', 'voip']);
const toMp3 = (buf) => ffmpeg(buf, 'in.bin', 'out.mp3', ['-vn', '-ac', '2', '-ar', '44100', '-b:a', '128k']);

// ---------- Lumi's voice ----------

const DIVINE_REPLIES = [
  'Stop tagging my babe he is busy with me',
  'Kain, stop that shii or face my wrath',
  'Tf, did he tell you he will not reply?',
];
const DIVINE_REACTIONS = []; // reactions are off: she only replies
let lastDivine = -1;
const divineFired = new Map();

function divineCheck(ctx) {
  const ids = S.protectedIds();
  if (!ctx.isGroup || !ids.length || !S.isProtectOn()) return null;
  if (!ctx.mentioned.map(numberOf).some((n) => ids.includes(n))) return null;
  if (ids.includes(ctx.senderNum)) return null; // Divine tagging himself
  const now = Date.now();
  if (now - (divineFired.get(ctx.jid) || 0) < CONFIG.protectedCooldownMs) return null;
  divineFired.set(ctx.jid, now);
  let i;
  do { i = rnd(DIVINE_REPLIES.length); } while (i === lastDivine);
  lastDivine = i;
  return { reply: DIVINE_REPLIES[i], emoji: DIVINE_REACTIONS.length ? pick(DIVINE_REACTIONS) : null };
}

const SLEEP_LINE = "Fine. I'm out. Wake me with 'lumi wake up' when you need me.";
const SLEEP_RE = /^\s*(?:(?:hey\s+)?lumi[\s,]+(?:go\s+(?:to\s+)?)?sleep(?:\s+now)?|sleep\s+(?:now\s+)?lumi|go\s+(?:to\s+)?sleep\s+lumi)\s*[.!]*\s*$/i;
const WAKE_RE = /^\s*(?:(?:hey\s+)?lumi[\s,]+wake(?:\s+up)?|wake\s+up\s+lumi|wake\s+lumi(?:\s+up)?)\s*[.!]*\s*$/i;

// ---------- sent-message tracking (a reply to one of these is a reply to Lumi) ----------

const sentIds = new Map();
const extraBotIds = new Set();
const wrapped = new WeakSet();
function trackSent(sock) {
  if (wrapped.has(sock)) return;
  wrapped.add(sock);
  const original = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const res = await original(...args);
    const id = res?.key?.id;
    if (id) {
      sentIds.set(id, Date.now());
      if (sentIds.size > 1000) for (const k of sentIds.keys()) { sentIds.delete(k); if (sentIds.size <= 800) break; }
    }
    return res;
  };
}
const botNumbers = (sock) => [sock.user?.id, sock.user?.lid].filter(Boolean).map(numberOf).concat([...extraBotIds]);

function isAddressed(ctx) {
  if (!ctx.isGroup) return true;
  if (/\blumi\b/i.test(ctx.text)) return true;
  const quotedId = ctx.ctxInfo?.stanzaId;
  if (quotedId && sentIds.has(quotedId)) {
    if (ctx.ctxInfo.participant) extraBotIds.add(numberOf(ctx.ctxInfo.participant));
    return true;
  }
  const bots = botNumbers(ctx.sock);
  if (ctx.mentioned.some((j) => bots.includes(numberOf(j)))) return true;
  return Boolean(ctx.ctxInfo?.participant && bots.includes(numberOf(ctx.ctxInfo.participant)));
}

// WhatsApp may show one person as a phone number AND a hidden id (LID): remember both.
function learnAliases(msg) {
  const uniqIds = uniq(senderIds(msg));
  if (uniqIds.length < 2) return;
  if (uniqIds.some(S.isMainOwner)) S.addClaimed(uniqIds);
  else if (uniqIds.some(S.isSubOwner)) S.addSubOwners(uniqIds);
  else if (uniqIds.some((n) => S.protectedIds().includes(n))) S.addProtectAlias(uniqIds);
}

// ---------- in-memory group log (for .recap, never saved) ----------

const chatLogs = new Map();
function logChat(jid, name, text) {
  let l = chatLogs.get(jid);
  if (!l) {
    if (chatLogs.size >= 150) chatLogs.delete(chatLogs.keys().next().value);
    l = [];
    chatLogs.set(jid, l);
  }
  l.push({ name: name || 'Someone', text: String(text).slice(0, 300) });
  if (l.length > 300) l.splice(0, l.length - 300);
}

// ---------- stickers ----------

let Fancy = null;
try { Fancy = require('wa-sticker-formatter'); } catch (_) { /* optional */ }
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* optional */ }

const MAX_IMAGE = 10 * 1024 * 1024, MAX_VIDEO = 15 * 1024 * 1024, MAX_SECONDS = 10;
const MAX_STATIC = 100 * 1024, MAX_ANIMATED = 1024 * 1024;
const sizeOf = (node) => Number(node.fileLength) || 0;

async function liteSticker(buf) {
  const SZ = 512;
  const mask = Buffer.from(`<svg width="${SZ}" height="${SZ}"><rect width="${SZ}" height="${SZ}" rx="96" ry="96" fill="#fff"/></svg>`);
  for (const quality of [85, 65, 45, 30]) {
    const out = await sharp(buf).resize(SZ, SZ, { fit: 'cover', position: sharp.strategy.attention })
      .composite([{ input: mask, blend: 'dest-in' }]).webp({ quality }).toBuffer();
    if (out.length <= MAX_STATIC) return out;
  }
  return null;
}
async function fancySticker(buf, pack, author) {
  for (const quality of [70, 50, 30]) {
    const s = new Fancy.Sticker(buf, { pack: pack || CONFIG.stickerPack, author: author || CONFIG.stickerAuthor, type: Fancy.StickerTypes.ROUNDED, quality, background: 'transparent' });
    const out = await s.toBuffer();
    if (out.length <= MAX_ANIMATED) return out;
  }
  return null;
}

async function makeSticker(ctx) {
  const media = findMedia(ctx.msg, ['image', 'video']);
  if (!media) return ctx.reply(`Reply to an image with ${S.prefix()}s`);
  if (media.kind === 'image' && sizeOf(media.node) > MAX_IMAGE) return ctx.reply('That image is too big (10 MB max).');
  if (media.kind === 'video') {
    if (!Fancy) return ctx.reply("Video stickers aren't enabled on this server. Images work.");
    if (sizeOf(media.node) > MAX_VIDEO) return ctx.reply('That video is too big (15 MB max).');
    if ((media.node.seconds || 0) > MAX_SECONDS) return ctx.reply(`Videos must be ${MAX_SECONDS} seconds or less.`);
  }
  if (!Fancy && !sharp) return ctx.reply("I can't make stickers on this server (sharp is missing).");
  const buf = await downloadMedia(ctx.sock, media.source);
  const out = media.kind === 'video' || Fancy ? await fancySticker(buf) : await liteSticker(buf);
  if (!out) return ctx.reply("Couldn't squeeze that under WhatsApp's sticker size limit.");
  return ctx.sock.sendMessage(ctx.jid, { sticker: out }, { quoted: ctx.msg });
}

// .toimg  (sticker -> image).  .take  (same, or `.take pack|author` re-stamps the sticker)
async function stickerToImage(ctx) {
  const media = findMedia(ctx.msg, ['sticker']);
  if (!media) return ctx.reply('Reply to a sticker first.');
  const buf = await downloadMedia(ctx.sock, media.source);
  if (media.node.isAnimated) {
    try {
      const gif = await sharp(buf, { animated: true }).gif().toBuffer();
      return ctx.sock.sendMessage(ctx.jid, { video: await gifToMp4(gif), gifPlayback: true }, { quoted: ctx.msg });
    } catch (_) { return ctx.reply("I can't convert animated stickers on this server. Static ones work."); }
  }
  if (!sharp) return ctx.reply("I can't convert that on this server (sharp is missing).");
  return ctx.sock.sendMessage(ctx.jid, { image: await sharp(buf).png().toBuffer() }, { quoted: ctx.msg });
}
async function takeSticker(ctx) {
  if (!ctx.argText) return stickerToImage(ctx);
  if (!Fancy) return ctx.reply("Renaming stickers isn't enabled on this server.");
  const media = findMedia(ctx.msg, ['sticker']);
  if (!media) return ctx.reply(`Reply to a sticker. Usage: ${S.prefix()}take pack|author`);
  const [pack, author] = ctx.argText.split('|').map((x) => x.trim());
  const out = await fancySticker(await downloadMedia(ctx.sock, media.source), pack, author);
  if (!out) return ctx.reply("Couldn't squeeze that under WhatsApp's sticker size limit.");
  return ctx.sock.sendMessage(ctx.jid, { sticker: out }, { quoted: ctx.msg });
}

// ---------- music (.play) : full song via YouTube + cobalt (same downloader as .dl); 30 s preview as fallback ----------
// Needs COBALT_API_URL for full songs. PLAY_MAX_SECONDS (default 600) caps the song length.
const PLAY_MAX_SECONDS = () => parseInt(process.env.PLAY_MAX_SECONDS, 10) || 600;
const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BAD_WORDS = /\b(cover|karaoke|instrumental|remix|slowed|sped up|reverb|8d|nightcore|reaction|tutorial|lesson)\b/i;

// "3:45" / "1:02:10" -> seconds
const toSeconds = (t) => String(t || '').split(':').map(Number).reduce((a, n) => a * 60 + (Number.isFinite(n) ? n : 0), 0);

// Pull the video results out of YouTube's search page.
function parseYoutube(html) {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html) || /ytInitialData"\]\s*=\s*(\{.*?\});/s.exec(html);
  if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch (_) { return []; }
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      out.push({
        id: v.videoId,
        title: (v.title && v.title.runs && v.title.runs.map((r) => r.text).join('')) || '',
        channel: (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || '',
        seconds: toSeconds(v.lengthText && v.lengthText.simpleText), // 0 = live stream
      });
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(data);
  return out;
}

// Best match: right length, not a cover/remix/karaoke (unless asked for), prefers the artist's own channel.
function pickVideo(videos, { query = '', artist = '', targetSeconds = 0, maxSeconds = 600 }) {
  let best = null;
  for (const v of videos) {
    if (!v.seconds || v.seconds < 60 || v.seconds > maxSeconds) continue;
    let score = targetSeconds ? Math.abs(v.seconds - targetSeconds) : Math.abs(v.seconds - 210);
    if (targetSeconds && Math.abs(v.seconds - targetSeconds) > 25) score += 500; // wrong version
    if (BAD_WORDS.test(v.title) && !BAD_WORDS.test(query)) score += 1000;
    if (artist && v.channel.toLowerCase().includes(artist.toLowerCase().split(/[,&]/)[0].trim())) score -= 20;
    if (/official/i.test(v.title) || /topic$/i.test(v.channel)) score -= 10;
    if (!best || score < best.score) best = { ...v, score };
  }
  return best && best.score < 500 ? best : null;
}

async function searchYoutube(q) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en`;
  const html = await http(url, { as: 'text', headers: { 'user-agent': PLAY_UA, 'accept-language': 'en-US,en;q=0.9' }, timeoutMs: 15000 });
  return parseYoutube(html);
}

const playBusy = new Set();
async function play(ctx) {
  const q = ctx.argText;
  if (!q) return ctx.reply(`Tell me what to look for. Example: ${S.prefix()}play artist - song`);
  if (playBusy.has(ctx.jid)) return ctx.reply('Still working on the last song. One at a time.');
  playBusy.add(ctx.jid);
  try { await playSong(ctx, q); } finally { playBusy.delete(ctx.jid); }
}
async function playSong(ctx, q) {
  await ctx.sock.sendMessage(ctx.jid, { react: { text: '🎧', key: ctx.msg.key } }).catch(() => {});

  // 1) song info (optional: if iTunes finds nothing we still try YouTube with the raw text)
  let t = null;
  try {
    const data = await http(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=1&country=${CONFIG.musicCountry}`, { timeoutMs: 15000 });
    t = data && data.results && data.results[0];
  } catch (e) { warn('iTunes search failed:', e.message); }

  const title = t ? t.trackName : q;
  const artist = t ? t.artistName : '';
  const target = t && t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : 0;
  const maxSeconds = PLAY_MAX_SECONDS();

  // 2) find the full audio
  let audio = null; let why = '';
  if (target > maxSeconds) why = `That one is ${Math.round(target / 60)} minutes long, over my ${Math.round(maxSeconds / 60)}-minute limit.`;
  else {
    try {
      const video = pickVideo(await searchYoutube(`${artist} ${title} audio`.trim()), { query: q, artist, targetSeconds: target, maxSeconds });
      if (!video) why = "I couldn't find a good full version of that song.";
      else {
        const [f] = await resolveLink(`https://www.youtube.com/watch?v=${video.id}`, true);
        const file = await fetchFile(f.url);
        if (file.type === 'text/html') throw new Error('not audio');
        audio = { buf: file.buf, mimetype: file.type.startsWith('audio/') ? file.type : 'audio/mpeg', video };
      }
    } catch (e) {
      warn(`play: full song failed: ${e.message}`);
      why = e.noService
        ? "Full songs need a downloader set up on my server (COBALT_API_URL)."
        : e.message === 'too big' ? "That song's file is too big to send." : "Couldn't download the full song right now.";
    }
  }

  // 3) the card: cover, names, links
  const name = t ? `*${t.trackName}*\n${t.artistName}${t.collectionName ? `\nAlbum: ${t.collectionName}` : ''}` : `*${q}*`;
  const links = t ? `\n\nListen: ${t.trackViewUrl}` : '';
  const caption = `${name}${links}${audio ? '' : `\n\n${why} ${t && t.previewUrl ? 'Sending a 30-second preview instead.' : ''}`}`.trim();
  if (t && t.artworkUrl100) {
    try {
      const img = await http(t.artworkUrl100.replace('100x100', '600x600'), { as: 'buffer', timeoutMs: 15000 });
      await ctx.sock.sendMessage(ctx.jid, { image: img, caption }, { quoted: ctx.msg });
    } catch (_) { await ctx.reply(caption); }
  } else await ctx.reply(caption);

  // 4) the song
  if (audio) {
    try { return await ctx.sock.sendMessage(ctx.jid, { audio: audio.buf, mimetype: audio.mimetype, ptt: false }, { quoted: ctx.msg }); }
    catch (e) { warn('play: sending audio failed:', e.message); }
  }
  if (t && t.previewUrl) {
    try {
      const preview = await http(t.previewUrl, { as: 'buffer', timeoutMs: 20000 });
      await ctx.sock.sendMessage(ctx.jid, { audio: preview, mimetype: 'audio/mp4', ptt: false }, { quoted: ctx.msg });
    } catch (_) { await ctx.reply("The preview wouldn't load either. Try the link above."); }
  } else if (!audio) await ctx.reply(t ? "No audio available. Use the link above." : "I couldn't find that one. Try 'artist - song'.");
}

// ---------- voice notes (.voice) : Google Translate text-to-speech -> WhatsApp voice note ----------

const VOICE_LANGS = new Set(['en', 'fr', 'es', 'de', 'pt', 'it', 'hi', 'ar', 'sw', 'ja', 'ko', 'zh', 'ru', 'tr', 'nl', 'id']);
const voiceUse = new Map();
let lastCreateAt = 0;
function speakable(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, ' link ').replace(/[*_~`#>|]/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function chunkText(text, size = 180) {
  const out = []; let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const s of text.match(/[^.!?;:\n]+[.!?;:]*\s*/g) || [text]) {
    if ((cur + s).length <= size) { cur += s; continue; }
    push();
    if (s.length <= size) { cur = s; continue; }
    for (const w of s.split(/\s+/)) {
      if (w.length > size) { push(); for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size)); continue; }
      if ((cur + ' ' + w).trim().length > size) push();
      cur = (cur + ' ' + w).trim();
    }
  }
  push();
  return out;
}
const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
const voiceName = () => store.voiceName || process.env.VOICE_NAME || 'Despina';
const geminiOn = () => Boolean(process.env.GEMINI_API_KEY) && (process.env.VOICE_PROVIDER || '').toLowerCase() !== 'google';
const findAudio = (n, d = 0) => {
  if (!n || typeof n !== 'object' || d > 8) return null;
  if (n.type === 'audio' && typeof n.data === 'string' && n.data.length > 100) return n.data;
  for (const v of Object.values(n)) { const f = findAudio(v, d + 1); if (f) return f; }
  return null;
};
async function geminiSpeak(text) {
  const res = await http('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', timeoutMs: 30000, headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.VOICE_MODEL || 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: process.env.VOICE_STYLE || 'calm, cool and relaxed, soft and unhurried, warm and natural, with a clean dry studio sound and no echo or reverb' }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: voiceName() }] },
    }),
  });
  const b64 = findAudio(res);
  if (!b64) throw new Error('Gemini voice sent no audio');
  return Buffer.from(b64, 'base64');
}
async function synthesize(text, lang) {
  if (geminiOn()) { try { return await geminiSpeak(speakable(text)); } catch (e) { warn('Gemini voice failed, using the backup voice:', e.message); } }
  const parts = [];
  for (const chunk of chunkText(speakable(text))) {
    parts.push(await http(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(chunk)}`,
      { as: 'buffer', timeoutMs: 15000, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', referer: 'https://translate.google.com/' } }));
  }
  if (!parts.length) throw new Error('nothing to say');
  return Buffer.concat(parts);
}

// ---------- downloader (.dl) ----------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EXT_KIND = { mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', '3gp': 'video', mp3: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio', wav: 'audio', aac: 'audio', flac: 'audio', jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image' };
const extOf = (u) => { try { return new URL(u).pathname.split('.').pop().toLowerCase(); } catch (_) { return ''; } };

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? isPrivateIp(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('private address');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('private address'); return; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (_) { return; }
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('private address');
}
async function getJson(url, { method = 'GET', headers = {}, body, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { 'user-agent': UA, ...headers }, body, signal: ctrl.signal });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok && !(data && typeof data === 'object')) throw new Error(`HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(timer); }
}
async function readLimited(res, max) {
  if (Number(res.headers.get('content-length') || 0) > max) throw new Error('too big');
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch (_) {} throw new Error('too big'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
async function fetchFile(url) {
  let cur = url;
  for (let i = 0; i < 5; i++) {
    await assertPublic(cur);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(cur, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'manual', signal: ctrl.signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).toString(); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await readLimited(res, CONFIG.dlMaxBytes);
      return { buf, type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), url: cur };
    } finally { clearTimeout(timer); }
  }
  throw new Error('too many redirects');
}
async function viaTikwm(url, wantAudio) {
  const r = await getJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
  const d = r && r.data;
  if (!r || r.code !== 0 || !d) throw new Error((r && r.msg) || 'tikwm failed');
  const base = 'https://www.tikwm.com';
  const abs = (u) => new URL(u, base).toString();
  if (wantAudio) { if (!d.music) throw new Error('no audio'); return [{ url: abs(d.music), hint: 'audio', title: d.title }]; }
  if (Array.isArray(d.images) && d.images.length) return d.images.slice(0, 8).map((u, i) => ({ url: abs(u), hint: 'image', title: i === 0 ? d.title : '' }));
  const v = d.hdplay || d.play;
  if (!v) throw new Error('no video');
  return [{ url: abs(v), hint: 'video', title: d.title }];
}
async function viaCobalt(url, wantAudio) {
  if (!CONFIG.cobaltUrl) throw new Error('no cobalt');
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (CONFIG.cobaltKey) headers.authorization = `Api-Key ${CONFIG.cobaltKey}`;
  const r = await getJson(CONFIG.cobaltUrl.replace(/\/+$/, '') + '/', {
    method: 'POST', headers, timeoutMs: 45000,
    body: JSON.stringify({ url, downloadMode: wantAudio ? 'audio' : 'auto', videoQuality: '720', filenameStyle: 'basic' }),
  });
  if (!r) throw new Error('empty answer');
  if (r.status === 'error') throw new Error((r.error && r.error.code) || 'cobalt error');
  if ((r.status === 'tunnel' || r.status === 'redirect') && r.url) return [{ url: r.url, hint: wantAudio ? 'audio' : 'video', name: r.filename }];
  if (r.status === 'picker' && Array.isArray(r.picker)) return r.picker.slice(0, 8).map((p) => ({ url: p.url, hint: p.type === 'photo' ? 'image' : 'video' }));
  throw new Error('unexpected answer');
}
async function resolveLink(url, wantAudio) {
  const tried = [];
  if (/(^|\.)tiktok\.com$/i.test(new URL(url).hostname)) {
    try { return await viaTikwm(url, wantAudio); } catch (e) { tried.push(`tikwm: ${e.message}`); }
  }
  if (CONFIG.cobaltUrl) {
    try { return await viaCobalt(url, wantAudio); } catch (e) { tried.push(`cobalt: ${e.message}`); }
  }
  if (EXT_KIND[extOf(url)]) return [{ url, hint: EXT_KIND[extOf(url)] }];
  const err = new Error(tried.join(' | ') || 'no downloader');
  err.noService = !CONFIG.cobaltUrl && !/tiktok\.com/i.test(url);
  throw err;
}
async function sendFile(ctx, f, caption) {
  const file = await fetchFile(f.url);
  if (file.type === 'text/html') throw new Error('that link is a web page, not a file');
  const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : EXT_KIND[extOf(file.url)] || f.hint || 'document';
  const q = { quoted: ctx.msg };
  const cap = caption ? String(caption).slice(0, 300) : undefined;
  if (kind === 'video') return ctx.sock.sendMessage(ctx.jid, { video: file.buf, mimetype: 'video/mp4', caption: cap }, q);
  if (kind === 'audio') return ctx.sock.sendMessage(ctx.jid, { audio: file.buf, mimetype: file.type.startsWith('audio/') ? file.type : 'audio/mpeg', ptt: false }, q);
  if (kind === 'image') return ctx.sock.sendMessage(ctx.jid, { image: file.buf, caption: cap }, q);
  const name = f.name || decodeURIComponent(new URL(file.url).pathname.split('/').pop() || 'file');
  return ctx.sock.sendMessage(ctx.jid, { document: file.buf, mimetype: file.type || 'application/octet-stream', fileName: name }, q);
}
async function download(ctx) {
  const quoted = ctx.ctxInfo?.quotedMessage ? getText(unwrap(ctx.ctxInfo.quotedMessage)) : '';
  const urlRe = /https?:\/\/[^\s<>"']+/i;
  const url = (urlRe.exec(ctx.argText) || urlRe.exec(quoted) || [])[0];
  if (!url) return ctx.reply(`Give me a link, or reply to one.\nExample: ${S.prefix()}dl https://vm.tiktok.com/xxxx\nAdd "audio" to get just the sound.`);
  const wantAudio = /\b(?:audio|mp3)\b/i.test(ctx.argText.replace(url, ''));
  await ctx.sock.sendMessage(ctx.jid, { react: { text: '⏳', key: ctx.msg.key } }).catch(() => {});
  let files;
  try { files = await resolveLink(url, wantAudio); } catch (e) {
    warn('dl could not resolve a link:', e.message);
    if (e.noService) return ctx.reply("I can't download from that site yet. The server needs a downloader set up (COBALT_API_URL). TikTok and direct file links work without it.");
    return ctx.reply("Couldn't get that one. The link may be private, or the downloader is down.");
  }
  let sentAny = false;
  for (const f of files) {
    try { await sendFile(ctx, f, f.title); sentAny = true; } catch (e) {
      warn('dl send failed:', e.message);
      if (e.message === 'too big') return ctx.reply(`That file is over ${Math.round(CONFIG.dlMaxBytes / 1048576)} MB. Too big to send.`);
      if (!sentAny && files.length === 1) return ctx.reply(/web page/.test(e.message) ? "That's a web page, not a file." : 'Found it, but the download failed. Try again in a bit.');
    }
  }
  if (!sentAny) return ctx.reply('Found it, but none of the files would download.');
}

// ---------- view-once reveal (owner) + vault ----------
// Lumi keeps a memory-only copy of view-once messages for 6 hours (nothing is written to disk), so .vv still
// works after they are opened. VAULT_ALL=true also keeps ordinary messages (no media). Max 600 entries.
const VO_KINDS = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document' };
const VAULT_TTL = 6 * 3600 * 1000, VAULT_MAX = 600, VAULT_MAX_MEDIA = 12 * 1024 * 1024;
const vault = new Map(); // "jid|id" -> { at, raw, viewOnce, mediaBuffer }
const vaultKeepAll = () => /^(1|true|yes|on)$/i.test(process.env.VAULT_ALL || '');
function vaultPrune() {
  for (const [k, r] of vault) if (Date.now() - r.at > VAULT_TTL) vault.delete(k);
  while (vault.size > VAULT_MAX) vault.delete(vault.keys().next().value);
}
function isViewOnceMsg(message) {
  let c = message || {};
  for (let i = 0; i < 8; i++) {
    if (c.viewOnceMessage || c.viewOnceMessageV2 || c.viewOnceMessageV2Extension) return true;
    const n = c.ephemeralMessage?.message || c.documentWithCaptionMessage?.message;
    if (!n) break;
    c = n;
  }
  return Object.keys(VO_KINDS).some((k) => c[k] && c[k].viewOnce === true);
}
// Remember a message (view-once only by default) and grab its media while WhatsApp still serves it.
async function vaultRemember(sock, msg) {
  try {
    if (!msg.message || msg.message.protocolMessage) return;
    const vo = isViewOnceMsg(msg.message);
    if (!vo && !vaultKeepAll()) return;
    const rec = { at: Date.now(), raw: msg, viewOnce: vo, mediaBuffer: null };
    vault.set(`${msg.key.remoteJid}|${msg.key.id}`, rec);
    vaultPrune();
    if (!vo) return;
    let c = msg.message;
    for (let i = 0; i < 6; i++) { const n = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c.viewOnceMessageV2Extension?.message || c.documentWithCaptionMessage?.message; if (!n) break; c = n; }
    const key = Object.keys(VO_KINDS).find((k) => c[k]);
    if (!key || Number(c[key].fileLength || 0) > VAULT_MAX_MEDIA) return;
    let buf;
    try { buf = await downloadMedia(sock, { key: msg.key, message: msg.message }); }
    catch (_) { const st = await downloadContentFromMessage(c[key], VO_KINDS[key]); const ch = []; for await (const x of st) ch.push(x); buf = Buffer.concat(ch); }
    if (buf && buf.length >= 100 && buf.length <= VAULT_MAX_MEDIA) rec.mediaBuffer = buf;
  } catch (e) { warn('vault: could not save media:', e.message); }
}
const vaultLookup = (jid, id) => { const r = vault.get(`${jid}|${id}`); return r && Date.now() - r.at <= VAULT_TTL ? r : null; };

function findViewOnce(quoted) {
  let m = quoted, wrappedVo = false;
  for (let i = 0; i < 6 && m; i++) {
    const vo = m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension;
    if (vo) { wrappedVo = true; m = vo.message; continue; }
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue; }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }
  if (!m) return null;
  for (const key of Object.keys(VO_KINDS)) {
    const node = m[key];
    if (node && (wrappedVo || node.viewOnce === true)) return { key, type: VO_KINDS[key], node };
  }
  return null;
}
function contextInfoDeep(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (node.contextInfo) return node.contextInfo;
  for (const v of Object.values(node)) {
    if (!v || typeof v !== 'object' || Buffer.isBuffer(v)) continue;
    const f = contextInfoDeep(v, depth + 1);
    if (f) return f;
  }
  return null;
}
async function voToBuffer(node, type) {
  const stream = await downloadContentFromMessage(node, type);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}
async function revealViewOnce(ctx, toDm) {
  try {
    const context = ctx.ctxInfo?.quotedMessage ? ctx.ctxInfo : contextInfoDeep(ctx.msg?.message);
    const quoted = context?.quotedMessage;
    if (!quoted) return await ctx.reply('Reply to a view-once message');
    const saved = context.stanzaId ? vaultLookup(ctx.jid, context.stanzaId) : null; // copy saved on arrival
    let found = findViewOnce(quoted) || (saved && findViewOnce(saved.raw.message));
    if (!found) return await ctx.reply('Reply to a view-once message');
    let buffer = saved && saved.mediaBuffer;
    if (!buffer) {
      try { buffer = await voToBuffer(found.node, found.type); }
      catch (e) {
        const raw = saved && findViewOnce(saved.raw.message);
        if (!raw) throw e;
        buffer = await voToBuffer(raw.node, raw.type);
      }
    }
    if (!buffer || !buffer.length) throw new Error('empty download');
    const { key, node } = found;
    const content = key === 'imageMessage' ? { image: buffer, caption: node.caption || '' }
      : key === 'videoMessage' ? { video: buffer, caption: node.caption || '', mimetype: node.mimetype || 'video/mp4' }
      : key === 'documentMessage' ? { document: buffer, mimetype: node.mimetype || 'application/octet-stream', fileName: node.fileName || 'revealed-file' }
      : { audio: buffer, mimetype: node.mimetype || 'audio/ogg; codecs=opus', ptt: node.ptt === true };
    if (toDm) {
      const k = ctx.msg.key;
      const dm = ctx.isGroup ? ([k.participantPn, k.participantAlt, ctx.sender].find((j) => j && j.endsWith('@s.whatsapp.net')) || ctx.sender) : ctx.jid;
      await ctx.sock.sendMessage(dm, content);
      if (dm !== ctx.jid) await ctx.sock.sendMessage(ctx.jid, { react: { text: '✅', key: ctx.msg.key } }).catch(() => {});
    } else await ctx.sock.sendMessage(ctx.jid, content, { quoted: ctx.msg });
  } catch (e) {
    warn('vv failed:', e.message);
    const gone = /404|410|not found|expired|directpath|url|empty/i.test(e.message);
    await ctx.reply(gone ? "I couldn't get it. WhatsApp no longer serves that file and I didn't catch it when it arrived." : "Couldn't reveal that one.").catch(() => {});
  }
}

// ---------- games ----------

const IDLE = 10 * 60 * 1000;
const live = (map, id, idle = IDLE) => {
  const g = map.get(id);
  if (g && Date.now() - g.at > idle) { map.delete(id); return null; }
  return g || null;
};
const win = (ctx) => addWin(ctx.senderNum, ctx.pushName);
const P = () => S.prefix();

const RPS = { rock: '🪨', paper: '📄', scissors: '✂️' };
const RPS_ALIAS = { r: 'rock', rock: 'rock', p: 'paper', paper: 'paper', s: 'scissors', scissor: 'scissors', scissors: 'scissors' };
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const BALL = ['Yes.', 'No.', 'Obviously.', "Don't count on it.", 'Ask me when I care.', 'Probably.', 'Doubt it.', 'Without a doubt.', 'Not a chance.', 'Maybe. Maybe not.', 'The signs say yes.', "I wouldn't."];
const REEL = ['🍒', '🍋', '🍇', '🔔', '💎', '7️⃣'];

const guessGames = new Map(), GUESS_MAX = 10;
const mathGames = new Map();
function mathQuestion() {
  const t = rnd(3), a = 2 + rnd(40), b = 2 + rnd(40);
  if (t === 0) return { q: `${a} + ${b}`, a: a + b };
  if (t === 1) { const [x, y] = a >= b ? [a, b] : [b, a]; return { q: `${x} - ${y}`, a: x - y }; }
  const m = 2 + rnd(11), n = 2 + rnd(11);
  return { q: `${m} × ${n}`, a: m * n };
}

const tttGames = new Map();
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const cell = (b, i) => (b[i] === 'x' ? '❌' : b[i] === 'o' ? '⭕' : NUM[i]);
const renderBoard = (b) => [0, 3, 6].map((r) => `${cell(b, r)}${cell(b, r + 1)}${cell(b, r + 2)}`).join('\n');
const winnerOf = (b) => { for (const [a, c, d] of TTT_LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a]; return null; };
const tttSend = (ctx, g, head) => ctx.reply(`${head}\n\n${renderBoard(g.board)}`, { mentions: [g.xJid, g.oJid] });

const hangGames = new Map();
const WORDS = ['whatsapp', 'keyboard', 'sunrise', 'journey', 'thunder', 'pyramid', 'puzzle', 'monster', 'library', 'diamond', 'shadow', 'rainbow', 'volcano', 'compass', 'lantern', 'blanket', 'penguin', 'dragon', 'galaxy', 'mystery', 'pocket', 'jungle', 'picnic', 'harvest', 'warrior', 'whisper', 'crystal', 'silence', 'garden', 'bridge'];
const HANG_MAX = 6;
const hangView = (g) => `${[...g.word].map((c) => (g.guessed.has(c) ? c : '_')).join(' ')}\nLives: ${'❤️'.repeat(HANG_MAX - g.wrong)}${'🖤'.repeat(g.wrong)}` + (g.wrongLetters.length ? `\nWrong: ${g.wrongLetters.join(' ')}` : '');

// ---------- the commands ----------
// Each: { name, aliases, category, menu: [...shown in menu], hidden, ownerOnly, mainOwnerOnly, run(ctx) }

const sendMenu = (ctx) => ctx.reply(buildMenu());

// ---------- poll / jail / group picture / saved stickers ----------
const idsOfPart = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf);
const targetsOf = (ctx) => uniq(ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []));
const POLL_COOLDOWN_MS = 15000;
const pollAt = new Map();
function parsePoll(raw) {
  let text = String(raw || '');
  const multi = /(?:^|\s)--multi\b/i.test(text);
  text = text.replace(/(?:^|\s)--multi\b/ig, ' ').trim();
  const [name, ...values] = text.split(/\s*[|\n]\s*/).map((x) => x.trim()).filter(Boolean);
  return { name, values: [...new Set(values)], multi };
}
const MAX_JAILED_PER_GROUP = 20;
function parseJailTime(a) {
  const m = /^(\d+)\s*(m|min|h|hr|d|day|days)$/i.exec(String(a || '').trim());
  if (!m) return null;
  const u = m[2].toLowerCase();
  const ms = parseInt(m[1], 10) * (u.startsWith('d') ? 86400000 : u.startsWith('h') ? 3600000 : 60000);
  return ms >= 60000 && ms <= 7 * 86400000 ? ms : null;
}
const fmtJail = (ms) => { const m = Math.ceil(ms / 60000); return m >= 1440 ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`; };
function jailRecord(jid, ids) {
  const g = store.jail[jid];
  if (!g) return null;
  for (const [key, rec] of Object.entries(g)) {
    if (rec.until && rec.until <= Date.now()) { delete g[key]; save(); continue; }
    if (rec.ids.some((n) => ids.includes(n))) return rec;
  }
  return null;
}
// Jailed person's message in a group: delete it. Returns true if handled.
async function jailCheck(ctx) {
  if (!ctx.isGroup || !store.jail[ctx.jid] || S.isOwner(ctx.senderNum)) return false;
  const k = ctx.msg.key;
  const ids = uniq([k.participant, k.participantAlt, k.participantPn].filter(Boolean).map(numberOf));
  if (!jailRecord(ctx.jid, ids)) return false;
  try { await ctx.sock.sendMessage(ctx.jid, { delete: k }); } catch (e) { warn('jail delete failed:', e.message); }
  return true;
}
const STICKER_DIR = path.join(CONFIG.dataDir, 'stickers');
const STICKER_MAX_BYTES = 1024 * 1024, STICKER_MAX_TOTAL = 200, STICKER_MAX_PER_USER = 30;
const stickerName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
const stickerFile = (n) => path.join(STICKER_DIR, `${n}.webp`);

const funCommands = [
  {
    // .poll Best food? | Rice | Beans | Yam   (2-12 options, --multi = several answers)
    name: 'poll', aliases: ['createpoll'], category: 'GROUP TOOLS', menu: ['poll <question> | <option> | <option>'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Polls are for groups.');
      const { name, values, multi } = parsePoll(ctx.argText);
      if (!name || values.length < 2) return ctx.reply(`Give me a question and at least 2 options, split with |\nExample: ${S.prefix()}poll Best food? | Rice | Beans | Yam\nAdd --multi to let people pick several.`);
      if (values.length > 12) return ctx.reply('12 options at most.');
      if (name.length > 200 || values.some((v) => v.length > 100)) return ctx.reply('Keep the question under 200 characters and each option under 100.');
      if (!ctx.isOwner && Date.now() - (pollAt.get(ctx.jid) || 0) < POLL_COOLDOWN_MS) return ctx.reply('One poll at a time. Give it a few seconds.');
      pollAt.set(ctx.jid, Date.now());
      return ctx.sock.sendMessage(ctx.jid, { poll: { name, values, selectableCount: multi ? 0 : 1 } });
    },
  },
  {
    // .gcpp = this group's picture. Owner in a private chat: .gcpp <group name>
    name: 'gcpp', aliases: ['gcpic', 'groupicon', 'gcicon', 'getgcpp'], category: 'GROUP TOOLS', menu: ['gcpp'],
    run: async (ctx) => {
      let target = ctx.isGroup ? ctx.jid : null; let title = '';
      if (!target) {
        if (!ctx.isOwner) return ctx.reply('Use this inside the group.');
        const q = ctx.argText.trim().toLowerCase();
        if (!q) return ctx.reply(`Use it in the group, or tell me which one: ${S.prefix()}gcpp <group name>`);
        const hits = Object.values(await ctx.sock.groupFetchAllParticipating()).filter((g) => String(g.subject || '').toLowerCase().includes(q));
        if (!hits.length) return ctx.reply("I'm not in a group with that name.");
        if (hits.length > 1) return ctx.reply(`More than one match:\n${hits.slice(0, 8).map((g) => `• ${g.subject}`).join('\n')}\nBe more specific.`);
        target = hits[0].id; title = hits[0].subject;
      }
      let url;
      try { url = await ctx.sock.profilePictureUrl(target, 'image'); } catch (_) { return ctx.reply("This group has no picture, or I can't see it."); }
      if (!url) return ctx.reply('This group has no picture.');
      const img = await http(url, { as: 'buffer', timeoutMs: 15000 });
      return ctx.sock.sendMessage(ctx.jid, { image: img, caption: title || undefined }, { quoted: ctx.msg });
    },
  },
  {
    // .jail @user [30m|2h|1d]  - Lumi deletes everything they send. Needs Lumi admin. Admins/owners are safe.
    name: 'jail', aliases: ['silence'], category: 'GROUP TOOLS', menu: ['jail @user [time]', 'unjail @user', 'jailed'],
    run: async (ctx) => {
      const info = await adminGuard(ctx);
      if (!info) return;
      const targets = targetsOf(ctx);
      if (!targets.length) return ctx.reply(`Tag who to jail, or reply to their message.\nExample: ${S.prefix()}jail @user 2h`);
      const timeArg = ctx.args.find((a) => /^\d+\s*(?:m|min|h|hr|d|days?)$/i.test(a));
      const ms = timeArg ? parseJailTime(timeArg) : 0;
      if (timeArg && !ms) return ctx.reply('Time can be 1m to 7d. Example: 30m, 2h, 1d.');
      const g = (store.jail[ctx.jid] ||= {});
      const prot = S.protectedIds();
      const done = []; const skipped = [];
      for (const t of targets) {
        const n = numberOf(t);
        const part = info.meta.participants.find((p) => idsOfPart(p).includes(n));
        const ids = uniq([n, ...(part ? idsOfPart(part) : [])]);
        if (info.botNumbers.some((b) => ids.includes(b)) || ids.some((x) => S.isOwner(x) || prot.includes(x))) { skipped.push('me/owner'); continue; }
        if (ids.some((x) => info.admins.has(x))) { skipped.push('an admin'); continue; }
        if (Object.keys(g).length >= MAX_JAILED_PER_GROUP && !g[ids[0]]) { skipped.push('(jail is full)'); continue; }
        g[ids[0]] = { ids, until: ms ? Date.now() + ms : 0, by: ctx.senderNum, at: Date.now() };
        done.push(ids[0]);
      }
      save();
      if (!done.length) return ctx.reply(`Can't jail ${skipped[0] || 'them'}. Pick someone else.`);
      return ctx.sock.sendMessage(ctx.jid, {
        text: `Jailed ${done.map((d) => `@${d}`).join(', ')}${ms ? ` for ${fmtJail(ms)}` : ''}. Everything they send gets deleted.${skipped.length ? `\nSkipped: ${skipped.join(', ')}.` : ''}`,
        mentions: done.map((d) => `${d}@s.whatsapp.net`),
      }, { quoted: ctx.msg });
    },
  },
  {
    name: 'unjail', aliases: ['free', 'release'], category: 'GROUP TOOLS', menu: [],
    run: async (ctx) => {
      const info = await adminGuard(ctx, { needBotAdmin: false });
      if (!info) return;
      const g = store.jail[ctx.jid] || {};
      if (/^all$/i.test(ctx.args[0] || '')) {
        const c = Object.keys(g).length; delete store.jail[ctx.jid]; save();
        return ctx.reply(c ? `Freed everyone (${c}).` : 'Nobody is jailed here.');
      }
      const targets = targetsOf(ctx);
      if (!targets.length) return ctx.reply(`Tag who to free, or: ${S.prefix()}unjail all`);
      let freed = 0;
      for (const t of targets) { const n = numberOf(t); for (const [k, r] of Object.entries(g)) if (k === n || r.ids.includes(n)) { delete g[k]; freed++; } }
      save();
      return ctx.reply(freed ? 'Freed. Behave.' : "They weren't jailed.");
    },
  },
  {
    name: 'jailed', aliases: ['jaillist'], category: 'GROUP TOOLS', menu: [],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const rows = Object.entries(store.jail[ctx.jid] || {}).filter(([, r]) => !r.until || r.until > Date.now());
      if (!rows.length) return ctx.reply('Nobody is jailed here.');
      return ctx.sock.sendMessage(ctx.jid, {
        text: `Jailed here:\n${rows.map(([k, r]) => `• @${k}${r.until ? ` (${fmtJail(r.until - Date.now())} left)` : ''}`).join('\n')}`,
        mentions: rows.map(([k]) => `${k}@s.whatsapp.net`),
      }, { quoted: ctx.msg });
    },
  },
  {
    // Saved stickers. Files live in DATA_DIR/stickers (use a volume on Railway or they vanish on redeploy).
    name: 'savesticker', aliases: ['ssave', 'stealsticker', 'addsticker'], category: 'STICKER TOOLS', menu: ['savesticker <name>'],
    run: async (ctx) => {
      const name = stickerName(ctx.args[0]);
      const media = findMedia(ctx.msg, ['sticker']);
      if (!media) return ctx.reply(`Reply to a sticker with ${S.prefix()}savesticker <name>.`);
      if (!name) return ctx.reply(`Give it a name. Example: ${S.prefix()}savesticker laugh`);
      const items = store.stickers;
      if (items[name]) return ctx.reply(`"${name}" is taken. Pick another name.`);
      if (Object.keys(items).length >= STICKER_MAX_TOTAL) return ctx.reply('The sticker box is full.');
      if (!ctx.isOwner && Object.values(items).filter((i) => i.by === ctx.senderNum).length >= STICKER_MAX_PER_USER) return ctx.reply(`You already saved ${STICKER_MAX_PER_USER}. Delete one first.`);
      if ((Number(media.node.fileLength) || 0) > STICKER_MAX_BYTES) return ctx.reply('That sticker is too big (1 MB max).');
      let buf;
      try { buf = await downloadMedia(ctx.sock, media.source); } catch (_) { return ctx.reply("Couldn't download that sticker."); }
      if (!buf || !buf.length || buf.length > STICKER_MAX_BYTES) return ctx.reply("Couldn't save that sticker.");
      fs.mkdirSync(STICKER_DIR, { recursive: true });
      fs.writeFileSync(stickerFile(name), buf);
      items[name] = { by: ctx.senderNum, at: Date.now(), animated: Boolean(media.node.isAnimated) };
      save();
      return ctx.reply(`Saved as "${name}". Send it with ${S.prefix()}getsticker ${name}`);
    },
  },
  {
    name: 'getsticker', aliases: ['gs', 'sendsticker'], category: 'STICKER TOOLS', menu: ['getsticker <name>'],
    run: async (ctx) => {
      const name = stickerName(ctx.args[0]);
      if (!name) return ctx.reply(`Which one? ${S.prefix()}stickers shows the list.`);
      if (!store.stickers[name] || !fs.existsSync(stickerFile(name))) return ctx.reply(`No sticker called "${name}".`);
      return ctx.sock.sendMessage(ctx.jid, { sticker: fs.readFileSync(stickerFile(name)) }, { quoted: ctx.msg });
    },
  },
  {
    name: 'stickers', aliases: ['stickerlist', 'mystickers'], category: 'STICKER TOOLS', menu: ['stickers'],
    run: async (ctx) => {
      const names = Object.keys(store.stickers).sort();
      if (!names.length) return ctx.reply(`No saved stickers yet. Reply to one with ${S.prefix()}savesticker <name>.`);
      return ctx.reply(`Saved stickers (${names.length}):\n${names.map((n) => `• ${n}`).join('\n')}\n\nSend one: ${S.prefix()}getsticker <name>`);
    },
  },
  {
    name: 'delsticker', aliases: ['removesticker', 'unsavesticker'], category: 'STICKER TOOLS', menu: [],
    run: async (ctx) => {
      const name = stickerName(ctx.args[0]);
      const it = store.stickers[name];
      if (!name || !it) return ctx.reply('No sticker with that name.');
      if (!ctx.isOwner && it.by !== ctx.senderNum) return ctx.reply('Only who saved it (or the owner) can delete it.');
      delete store.stickers[name];
      try { fs.unlinkSync(stickerFile(name)); } catch (_) { /* already gone */ }
      save();
      return ctx.reply(`Deleted "${name}".`);
    },
  },
];


const commandList = [
  // GENERAL
  { name: 'menu', category: 'GENERAL', menu: ['menu'], run: sendMenu },
  { name: 'help', category: 'GENERAL', menu: ['help'], run: sendMenu },
  {
    name: 'ping', category: 'GENERAL', menu: ['ping'],
    run: (ctx) => ctx.reply(`Online. ${Math.max(0, Date.now() - Number(ctx.msg.messageTimestamp) * 1000)} ms.`), // approximate: WhatsApp timestamps are 1 s precision
  },
  {
    name: 'about', category: 'GENERAL', menu: ['about'],
    run: (ctx) => ctx.reply(
      `*Lumi* v${CONFIG.version}\n` +
      `${CONFIG.personality === 'calm' ? 'Calm, observant, a little sarcastic.' : CONFIG.personality === 'maki' ? 'Blunt, dry, unbothered.' : 'Warm and friendly to everyone, until you insult or annoy her.'} Quietly looks out for ${CONFIG.ownerName}.\n\n` +
      `Prefix: ${S.prefix()}\nType ${S.prefix()}menu to see what I can do.`),
  },
  {
    name: 'status', category: 'GENERAL', menu: ['status'],
    run: (ctx) => ctx.reply(
      `*Status*\nUptime: ${fmtUptime(Math.floor(process.uptime()))}\n` +
      `AI in this chat: ${S.isAiOn(ctx.jid) ? 'on' : 'off'}\n` +
      `${CONFIG.ownerName} protection: ${S.isProtectOn() && S.protectedIds().length ? 'on' : 'off'}`),
  },
  {
    name: 'owner', category: 'GENERAL', menu: ['owner'],
    run: (ctx) => {
      let t = `Owner: ${CONFIG.ownerName}`;
      if (CONFIG.showOwnerNumber && CONFIG.ownerIds[0]) t += `\nhttps://wa.me/${CONFIG.ownerIds[0]}`;
      return ctx.reply(t);
    },
  },

  // AI SYSTEM
  {
    name: 'chatbot', aliases: ['ai'], category: 'AI SYSTEM', menu: ['chatbot on', 'chatbot off'],
    run: (ctx) => {
      const arg = (ctx.args[0] || '').toLowerCase();
      if (arg !== 'on' && arg !== 'off') return ctx.reply('Use chatbot on or chatbot off.');
      if (ctx.isGroup && !ctx.isOwner) return ctx.reply('Only the owner can switch that in groups.');
      S.setAi(ctx.jid, arg === 'on');
      return ctx.reply(arg === 'on' ? 'Chatbot is on for this chat.' : 'Chatbot is off here. Commands still work.');
    },
  },
  {
    name: 'clear', category: 'AI SYSTEM', menu: ['clear'],
    run: (ctx) => { if (hooks.clearMemory) hooks.clearMemory(ctx.senderNum); return ctx.reply("Done. I've forgotten our conversation."); },
  },
  {
    name: 'protect', category: 'AI SYSTEM', menu: ['protect on', 'protect off'], ownerOnly: true,
    run: (ctx) => {
      const arg = (ctx.args[0] || '').toLowerCase();
      if (arg !== 'on' && arg !== 'off') return ctx.reply('Use protect on or protect off.');
      S.setProtect(arg === 'on');
      return ctx.reply(`Protection is ${arg}.`);
    },
  },
  {
    name: 'affinity', aliases: ['bond'], category: 'AI SYSTEM', menu: ['affinity [@user]'],
    run: (ctx) => {
      const t = targetNumbers(ctx)[0];
      const num = t || ctx.senderNum;
      const a = getAffinity(num);
      const who = t && t !== ctx.senderNum ? `@${num}` : 'You';
      const next = a.next ? `\n${a.next.need} more until "${a.next.level}".` : '\nThat is the top. Do not let it go to your head.';
      const mentions = ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []);
      return ctx.reply(`*Affinity*\n${who}: ${a.level} (${a.pts} pts)${next}`, who === 'You' ? {} : { mentions });
    },
  },

  // STICKER TOOLS
  { name: 's', aliases: ['sticker'], category: 'STICKER TOOLS', menu: ['s'], run: makeSticker },
  { name: 'take', category: 'STICKER TOOLS', menu: ['take'], run: takeSticker },
  { name: 'toimg', category: 'STICKER TOOLS', menu: ['toimg'], run: stickerToImage },

  // MEDIA
  { name: 'play', category: 'MEDIA', menu: ['play'], run: play },
  {
    name: 'tomp3', aliases: ['mp3'], category: 'MEDIA', menu: ['tomp3'],
    run: async (ctx) => {
      const media = findMedia(ctx.msg, ['video', 'audio']);
      if (!media) return ctx.reply(`Reply to a video or a voice note with ${S.prefix()}tomp3`);
      if (Number(media.node.fileLength) > 40 * 1024 * 1024) return ctx.reply('That file is too big (40 MB max).');
      await ctx.sock.sendMessage(ctx.jid, { react: { text: '⏳', key: ctx.msg.key } }).catch(() => {});
      const buf = await downloadMedia(ctx.sock, media.source);
      let mp3;
      try { mp3 = await toMp3(buf); } catch (_) { return ctx.reply("I can't convert audio on this server (ffmpeg is missing)."); }
      return ctx.sock.sendMessage(ctx.jid, { audio: mp3, mimetype: 'audio/mpeg', ptt: false }, { quoted: ctx.msg });
    },
  },

  {
    name: 'voice', aliases: ['tts', 'say'], category: 'MEDIA', menu: ['voice <text>', 'voice fr: bonjour'],
    run: async (ctx) => {
      const q = ctx.ctxInfo?.quotedMessage ? getText(unwrap(ctx.ctxInfo.quotedMessage)) : '';
      let lang = 'en', text = ctx.argText || q;
      const m = /^([a-z]{2})\s*[:,]?\s+(.+)$/is.exec(ctx.argText);
      if (m && VOICE_LANGS.has(m[1].toLowerCase())) { lang = m[1].toLowerCase(); text = m[2]; }
      if (!text) return ctx.reply(`Give me something to say.\nExample: ${S.prefix()}voice good morning everyone\nOr reply to a message with ${S.prefix()}voice. Languages: ${[...VOICE_LANGS].join(' ')}`);
      if (text.length > 500) return ctx.reply('That is too long for a voice note (500 characters max).');
      if (!ctx.isOwner) {
        const wait = 15000 - (Date.now() - (voiceUse.get(ctx.senderNum) || 0));
        if (wait > 0) return ctx.reply(`Give me ${Math.ceil(wait / 1000)} seconds.`);
        voiceUse.set(ctx.senderNum, Date.now());
      }
      try {
        const mp3 = await synthesize(text, lang);
        let content;
        try { content = { audio: await toVoiceNote(mp3), mimetype: 'audio/ogg; codecs=opus', ptt: true }; }
        catch (_) { content = { audio: mp3, mimetype: 'audio/mpeg', ptt: false }; }
        return ctx.sock.sendMessage(ctx.jid, content, { quoted: ctx.msg });
      } catch (e) { warn('voice failed:', e.message); return ctx.reply("My voice isn't working right now. Try again in a bit."); }
    },
  },

  {
    // .creategc Study Group  |  .creategc Study Group 2348012345678 2349087654321 (up to 10 people, you become admin)
    name: 'creategc', aliases: ['newgc', 'creategroup'], category: 'OWNER', menu: ['creategc <name> [numbers]'], ownerOnly: true,
    run: async (ctx) => {
      const isNum = (a) => /^\+?\d[\d-]*$/.test(a) && a.replace(/\D/g, '').length >= 7 && a.replace(/\D/g, '').length <= 15;
      const nums = ctx.args.filter(isNum).map((a) => a.replace(/\D/g, ''));
      const name = ctx.args.filter((a) => !isNum(a)).join(' ').trim();
      if (!name) return ctx.reply(`Give the group a name.\nExample: ${S.prefix()}creategc Study Group\nTo add people too: ${S.prefix()}creategc Study Group 2348012345678 2349087654321`);
      if (name.length > 100) return ctx.reply('Group names are 100 characters max.');
      const wait = 30000 - (Date.now() - lastCreateAt);
      if (wait > 0) return ctx.reply(`Slow down. WhatsApp bans accounts that create groups too fast. Try again in ${Math.ceil(wait / 1000)} seconds.`);
      const k = ctx.msg.key;
      const owner = [k.participantPn, k.participantAlt, k.remoteJidAlt, ctx.sender, ctx.jid].find((j) => j && j.endsWith('@s.whatsapp.net')) || ctx.sender;
      const bots = botNumbers(ctx.sock);
      const members = uniq([owner, ...nums.map((n) => `${n}@s.whatsapp.net`), ...ctx.mentioned]).filter((j) => !bots.includes(numberOf(j)));
      if (members.length > 11) return ctx.reply('That is too many people at once (10 max). Add the rest after.');
      lastCreateAt = Date.now();
      let created;
      try { created = await ctx.sock.groupCreate(name, members); } catch (e) { lastCreateAt = 0; warn('creategc failed:', e.message); return ctx.reply("WhatsApp wouldn't let me create it. Check the numbers are on WhatsApp, or try again in a bit."); }
      const id = created && created.id;
      if (!id) return ctx.reply("It didn't create properly. Check WhatsApp before trying again.");
      await ctx.sock.groupParticipantsUpdate(id, [owner], 'promote').catch(() => {});
      let link = '';
      try { link = `https://chat.whatsapp.com/${await ctx.sock.groupInviteCode(id)}`; } catch (_) {}
      return ctx.reply(`Created *${name}* with ${members.length} ${members.length === 1 ? 'person' : 'people'}.${link ? `\nLink: ${link}` : `\nI couldn't get the link yet. Send ${S.prefix()}gclink ${name} in a moment.`}\nYou're an admin there.`);
    },
  },
  {
    // .gclink: in a group = its link; in a private chat = lists my groups.  .gclink <name> = link of any group I'm admin in.
    name: 'gclink', aliases: ['grouplink', 'getlink'], category: 'OWNER', menu: ['gclink [group name]'], ownerOnly: true,
    run: async (ctx) => {
      const NO_ADMIN = "I'm not an admin there, and WhatsApp only gives links to admins. Make me an admin first.";
      const link = async (jid) => `https://chat.whatsapp.com/${await ctx.sock.groupInviteCode(jid)}`;
      const q = ctx.argText.trim().toLowerCase();
      if (!q && ctx.isGroup) { try { return await ctx.reply(`Group link:\n${await link(ctx.jid)}`); } catch (_) { return ctx.reply(NO_ADMIN); } }
      const bots = botNumbers(ctx.sock);
      const botAdmin = (m) => (m.participants || []).some((p) => p.admin && [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(numberOf).some((n) => bots.includes(n)));
      const all = Object.values(await ctx.sock.groupFetchAllParticipating()).sort((a, b) => String(a.subject).localeCompare(String(b.subject)));
      if (!all.length) return ctx.reply("I'm not in any groups.");
      if (!q) {
        const lines = all.slice(0, 30).map((m, i) => `${i + 1}. ${m.subject}${botAdmin(m) ? '' : ' (not admin)'}`);
        return ctx.reply(`*My groups*\n${lines.join('\n')}${all.length > 30 ? `\n...and ${all.length - 30} more` : ''}\n\nGet a link: ${S.prefix()}gclink <group name>`);
      }
      const exact = all.filter((m) => String(m.subject).toLowerCase() === q);
      const hits = exact.length ? exact : all.filter((m) => String(m.subject).toLowerCase().includes(q));
      if (!hits.length) return ctx.reply(`I'm not in a group called "${ctx.argText}". Send ${S.prefix()}gclink to see the list.`);
      if (hits.length > 1) return ctx.reply(`More than one match. Be more specific:\n${hits.slice(0, 10).map((m) => `• ${m.subject}`).join('\n')}`);
      if (!botAdmin(hits[0])) return ctx.reply(`${NO_ADMIN} (${hits[0].subject})`);
      try { return await ctx.reply(`*${hits[0].subject}*\n${await link(hits[0].id)}`); } catch (_) { return ctx.reply(`${NO_ADMIN} (${hits[0].subject})`); }
    },
  },
  ...funCommands,
  {
    name: 'setvoice', category: 'OWNER', menu: ['setvoice <name>'], ownerOnly: true,
    run: (ctx) => {
      const found = GEMINI_VOICES.find((n) => n.toLowerCase() === (ctx.args[0] || '').toLowerCase());
      if (!ctx.args[0]) return ctx.reply(`My voice: ${voiceName()}${geminiOn() ? '' : ' (Gemini voice is off: no GEMINI_API_KEY)'}\nChange it: ${S.prefix()}setvoice <name>\n\n${GEMINI_VOICES.join(', ')}`);
      if (!found) return ctx.reply(`I don't know a voice called "${ctx.args[0]}". Send ${S.prefix()}setvoice to see the list.`);
      store.voiceName = found; save();
      return ctx.reply(`Voice set to ${found}. Try ${S.prefix()}voice hello, this is my new voice.`);
    },
  },

  // DOWNLOAD
  { name: 'dl', aliases: ['download'], category: 'DOWNLOAD', menu: ['dl <link>', 'dl <link> audio'], run: download },

  // PROFILE
  {
    name: 'getpp', category: 'PROFILE', menu: ['getpp @user'],
    run: async (ctx) => {
      const target = ctx.mentioned[0] || ctx.ctxInfo?.participant || (!ctx.isGroup ? ctx.jid : null);
      if (!target) return ctx.reply(`Tag someone: ${S.prefix()}getpp @user`);
      let url;
      try { url = await ctx.sock.profilePictureUrl(target, 'image'); } catch (_) {
        return ctx.reply("I can't get that picture. They may not have one, or they've hidden it.");
      }
      if (!url) return ctx.reply('No profile picture available.');
      const img = await http(url, { as: 'buffer', timeoutMs: 15000 });
      return ctx.sock.sendMessage(ctx.jid, { image: img }, { quoted: ctx.msg });
    },
  },

  // GROUP TOOLS
  {
    name: 'add', category: 'GROUP TOOLS', menu: ['add <number>'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      const nums = ctx.args.map((a) => a.replace(/\D/g, '')).filter((n) => n.length >= 7 && n.length <= 15);
      if (!nums.length) return ctx.reply(`Give me a number with country code.\nExample: ${S.prefix()}add 2348012345678`);
      const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, nums.map((n) => `${n}@s.whatsapp.net`), 'add');
      const status = { 200: 'added', 403: 'their privacy settings block adding them', 408: 'they left recently and cannot be re-added yet', 409: 'already in the group' };
      return ctx.reply((res || []).map((r) => `${numberOf(r.jid)}: ${status[r.status] || `failed (${r.status})`}`).join('\n') || 'Nothing happened.');
    },
  },
  {
    name: 'kick', category: 'GROUP TOOLS', menu: ['kick @user'],
    run: async (ctx) => {
      const info = await adminGuard(ctx);
      if (!info) return;
      const targets = uniq(ctx.mentioned.length ? ctx.mentioned : (ctx.ctxInfo?.participant ? [ctx.ctxInfo.participant] : []));
      if (!targets.length) return ctx.reply(`Tag who to remove, or reply to their message.\nExample: ${S.prefix()}kick @user`);
      const prot = S.protectedIds();
      const blocked = targets.some((j) => { const n = numberOf(j); return info.botNumbers.includes(n) || S.isOwner(n) || prot.includes(n); });
      if (blocked) return ctx.reply('Not him. Not me either. Pick someone else.');
      const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, 'remove');
      const failed = (res || []).filter((r) => String(r.status) !== '200');
      return ctx.reply(failed.length ? "Couldn't remove everyone. Admins can't be removed by me." : 'Gone.');
    },
  },
  {
    // Tags everyone silently. Reply to a message/media and it is re-sent with the hidden tags. Bot need not be admin.
    name: 'hidetag', aliases: ['htag', 'tagall'], category: 'GROUP TOOLS', menu: ['hidetag [text]'],
    run: async (ctx) => {
      const info = await adminGuard(ctx, { needBotAdmin: false });
      if (!info) return;
      const mentions = uniq(info.meta.participants.map((p) => p.id).filter(Boolean));
      const q = ctx.ctxInfo?.quotedMessage;
      const text = ctx.argText || (q ? getText(unwrap(q)) : '') || '';
      const media = findMedia(ctx.msg, ['image', 'video', 'audio', 'sticker']);
      if (media) {
        if (Number(media.node.fileLength) > 30 * 1024 * 1024) return ctx.reply('That file is too big (30 MB max).');
        const buf = await downloadMedia(ctx.sock, media.source);
        const content =
          media.kind === 'image' ? { image: buf, caption: text, mentions } :
          media.kind === 'video' ? { video: buf, caption: text, mentions } :
          media.kind === 'audio' ? { audio: buf, mimetype: media.node.mimetype || 'audio/mp4', ptt: Boolean(media.node.ptt), mentions } :
          { sticker: buf, mentions };
        return ctx.sock.sendMessage(ctx.jid, content);
      }
      return ctx.sock.sendMessage(ctx.jid, { text: text || '📢', mentions });
    },
  },
  {
    name: 'promote', category: 'GROUP TOOLS', menu: ['promote @user'],
    run: (ctx) => updateMembers(ctx, 'promote', "Done. They're an admin now. Don't make me regret it.", `Tag who to promote, or reply to their message.\nExample: ${S.prefix()}promote @user`),
  },
  {
    name: 'demote', category: 'GROUP TOOLS', menu: ['demote @user'],
    run: (ctx) => updateMembers(ctx, 'demote', 'Done. Back to normal member.', `Tag who to demote, or reply to their message.\nExample: ${S.prefix()}demote @user`),
  },
  {
    name: 'link', category: 'GROUP TOOLS', menu: ['link'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      return ctx.reply(`Group link:\nhttps://chat.whatsapp.com/${await ctx.sock.groupInviteCode(ctx.jid)}`);
    },
  },
  {
    name: 'revoke', aliases: ['resetlink'], category: 'GROUP TOOLS', menu: ['revoke'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      await ctx.sock.groupRevokeInvite(ctx.jid);
      return ctx.reply(`Old link is dead. ${S.prefix()}link for the new one.`);
    },
  },
  groupSetting('mute', 'announcement', 'Group muted. Only admins can talk now. Peaceful.'),
  groupSetting('unmute', 'not_announcement', 'Group unmuted. Everyone can talk again. Unfortunately.'),
  groupSetting('lock', 'locked', 'Group info locked. Only admins can edit it.'),
  groupSetting('unlock', 'unlocked', 'Group info unlocked. Everyone can edit it.'),
  {
    name: 'setname', category: 'GROUP TOOLS', menu: ['setname <name>'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      if (!ctx.argText) return ctx.reply(`Give me the new name.\nExample: ${S.prefix()}setname Lumi Squad`);
      if (ctx.argText.length > 100) return ctx.reply('Group names are 100 characters max.');
      await ctx.sock.groupUpdateSubject(ctx.jid, ctx.argText);
      return ctx.reply('Name changed.');
    },
  },
  {
    name: 'setdesc', category: 'GROUP TOOLS', menu: ['setdesc <text>'],
    run: async (ctx) => {
      if (!(await adminGuard(ctx))) return;
      if (!ctx.argText) return ctx.reply(`Give me the new description.\nExample: ${S.prefix()}setdesc Be nice here`);
      await ctx.sock.groupUpdateDescription(ctx.jid, ctx.argText);
      return ctx.reply('Description changed.');
    },
  },
  {
    name: 'admins', category: 'GROUP TOOLS', menu: ['admins'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const meta = await ctx.sock.groupMetadata(ctx.jid);
      const admins = (meta.participants || []).filter((p) => p.admin === 'admin' || p.admin === 'superadmin');
      if (!admins.length) return ctx.reply('No admins. Anarchy.');
      const lines = admins.map((p) => `┃ ${p.admin === 'superadmin' ? '👑' : '🛡️'} @${numberOf(p.phoneNumber || p.id)}`).join('\n');
      return ctx.sock.sendMessage(ctx.jid, { text: `╭━━━「 ADMINS 」\n${lines}\n╰━━━━━━━━━━━━`, mentions: admins.map((p) => p.phoneNumber || p.id) }, { quoted: ctx.msg });
    },
  },
  {
    name: 'groupinfo', aliases: ['ginfo'], category: 'GROUP TOOLS', menu: ['groupinfo'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only.');
      const m = await ctx.sock.groupMetadata(ctx.jid);
      const people = m.participants || [];
      const created = m.creation ? new Date(m.creation * 1000).toLocaleDateString() : 'Unknown';
      return ctx.reply(
        `╭━━━「 GROUP INFO 」\n┃ Name: ${m.subject}\n┃ Members: ${people.length}\n┃ Admins: ${people.filter((p) => p.admin).length}\n` +
        `┃ Created: ${created}\n┃ Description: ${m.desc || 'None'}\n╰━━━━━━━━━━━━`);
    },
  },
  {
    name: 'recap', aliases: ['summary'], category: 'GROUP TOOLS', menu: ['recap [count]'],
    run: async (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only. A recap of one chat with you would be short.');
      if (!hooks.generate) return ctx.reply("My AI isn't hooked up here, so no recap.");
      const wanted = parseInt(ctx.args[0], 10);
      const n = Number.isFinite(wanted) ? Math.min(200, Math.max(10, wanted)) : 60;
      const lines = (chatLogs.get(ctx.jid) || []).slice(-n);
      if (lines.length < 5) return ctx.reply('Not enough to recap. I only keep what I saw since I last started.');
      if (Date.now() - (recapAt.get(ctx.jid) || 0) < 30000) return ctx.reply('I just did one. Give it 30 seconds.');
      recapAt.set(ctx.jid, Date.now());
      let transcript = lines.map((l) => `${l.name}: ${l.text}`).join('\n');
      if (transcript.length > 6000) transcript = transcript.slice(-6000);
      await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
      const result = await hooks.generate([
        { role: 'system', content: RECAP_SYSTEM },
        { role: 'user', content: `Chat (${lines.length} messages, oldest first):\n${transcript}` },
      ]);
      await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
      if (!result) return ctx.reply("My head's a bit foggy right now. Try me again in a minute.");
      return ctx.reply(`*Recap* (last ${lines.length} messages)\n${String(result.text).trim().slice(0, 1500)}`);
    },
  },

  // GAMES
  {
    name: 'rps', category: 'GAMES', menu: ['rps <rock|paper|scissors>'],
    run: (ctx) => {
      const you = RPS_ALIAS[(ctx.args[0] || '').toLowerCase()];
      if (!you) return ctx.reply(`Pick one: ${P()}rps rock | paper | scissors`);
      const me = pick(Object.keys(RPS));
      let verdict;
      if (you === me) verdict = 'Draw. Again.';
      else if (BEATS[you] === me) { win(ctx); verdict = pick(['You win. Enjoy it.', 'Fine. You got that one.']); }
      else verdict = pick(['I win.', 'Too easy.']);
      return ctx.reply(`${RPS[you]} vs ${RPS[me]}\n${verdict}`);
    },
  },
  {
    name: 'dice', aliases: ['roll'], category: 'GAMES', menu: ['dice [sides]'],
    run: (ctx) => {
      const sides = parseInt(ctx.args[0], 10) || 6;
      if (sides < 2 || sides > 1000) return ctx.reply('Between 2 and 1000 sides.');
      return ctx.reply(`🎲 ${1 + rnd(sides)}  (d${sides})`);
    },
  },
  { name: 'flip', aliases: ['coin', 'coinflip'], category: 'GAMES', menu: ['flip'], run: (ctx) => ctx.reply(`🪙 ${pick(['Heads.', 'Tails.'])}`) },
  {
    name: '8ball', aliases: ['ball'], category: 'GAMES', menu: ['8ball <question>'],
    run: (ctx) => (ctx.argText ? ctx.reply(`🎱 ${pick(BALL)}`) : ctx.reply(`Ask something. Example: ${P()}8ball will I pass`)),
  },
  {
    name: 'slots', aliases: ['slot'], category: 'GAMES', menu: ['slots'],
    run: (ctx) => {
      const r = [pick(REEL), pick(REEL), pick(REEL)];
      const line = `🎰 ${r.join(' | ')}`;
      if (r[0] === r[1] && r[1] === r[2]) { win(ctx); return ctx.reply(`${line}\nJackpot. Don't look so smug.`); }
      if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) return ctx.reply(`${line}\nAlmost. Pull again.`);
      return ctx.reply(`${line}\nNothing. Predictable.`);
    },
  },
  {
    name: 'guess', category: 'GAMES', menu: ['guess', 'guess <number>'],
    run: (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      const g = live(guessGames, ctx.jid);
      if (a === 'end' || a === 'stop') {
        if (!g) return ctx.reply('No game running.');
        guessGames.delete(ctx.jid);
        return ctx.reply(`It was ${g.n}. Giving up already?`);
      }
      if (!a) {
        if (g) return ctx.reply(`A game is on. Guess 1-100 with ${P()}guess <number>. Tries used: ${g.tries}/${GUESS_MAX}.`);
        guessGames.set(ctx.jid, { n: 1 + rnd(100), tries: 0, at: Date.now() });
        return ctx.reply(`I'm thinking of a number from 1 to 100. ${GUESS_MAX} tries, everyone shares them.\nGuess with ${P()}guess <number>`);
      }
      if (!/^\d{1,3}$/.test(a)) return ctx.reply(`Use a number: ${P()}guess 42`);
      if (!g) return ctx.reply(`No game running. Start one with ${P()}guess`);
      const n = parseInt(a, 10);
      g.tries += 1; g.at = Date.now();
      if (n === g.n) { guessGames.delete(ctx.jid); win(ctx); return ctx.reply(`${n}. Yes. Took ${g.tries} ${g.tries === 1 ? 'try' : 'tries'}.`); }
      if (g.tries >= GUESS_MAX) { guessGames.delete(ctx.jid); return ctx.reply(`Out of tries. It was ${g.n}.`); }
      return ctx.reply(`${n < g.n ? 'Higher.' : 'Lower.'} (${g.tries}/${GUESS_MAX})`);
    },
  },
  {
    name: 'math', aliases: ['quiz'], category: 'GAMES', menu: ['math', 'math <answer>'],
    run: (ctx) => {
      const a = (ctx.args[0] || '').trim();
      let g = live(mathGames, ctx.jid, 2 * 60 * 1000);
      if (!a) {
        if (!g) { g = { ...mathQuestion(), at: Date.now() }; mathGames.set(ctx.jid, g); }
        return ctx.reply(`🧮 ${g.q} = ?\nAnswer with ${P()}math <number>. First right answer wins.`);
      }
      if (!/^-?\d+$/.test(a)) return ctx.reply(`Use a number: ${P()}math 42`);
      if (!g) return ctx.reply(`No question running. Start one with ${P()}math`);
      if (parseInt(a, 10) !== g.a) return ctx.reply('No.');
      mathGames.delete(ctx.jid); win(ctx);
      return ctx.reply(`${g.q} = ${g.a}. Right. First one there.`);
    },
  },
  {
    name: 'ttt', aliases: ['tictactoe'], category: 'GAMES', menu: ['ttt @user', 'ttt <1-9>'],
    run: (ctx) => {
      if (!ctx.isGroup) return ctx.reply('Groups only. I need two people.');
      const g = live(tttGames, ctx.jid);
      const a = (ctx.args[0] || '').toLowerCase();
      if (a === 'end' || a === 'stop') {
        if (!g) return ctx.reply('No game running.');
        if (![g.x, g.o].includes(ctx.senderNum) && !ctx.isOwner) return ctx.reply("It's not your game.");
        tttGames.delete(ctx.jid);
        return ctx.reply('Game over. Nobody wins.');
      }
      if (/^[1-9]$/.test(a)) {
        if (!g) return ctx.reply(`No game here. Start one: ${P()}ttt @user`);
        const mark = g.x === ctx.senderNum ? 'x' : g.o === ctx.senderNum ? 'o' : null;
        if (!mark) return ctx.reply("You're not in this game.");
        if (g.turn !== mark) return ctx.reply('Not your turn.');
        const i = parseInt(a, 10) - 1;
        if (g.board[i]) return ctx.reply('That square is taken.');
        g.board[i] = mark; g.at = Date.now();
        const w = winnerOf(g.board);
        if (w) { tttGames.delete(ctx.jid); win(ctx); return tttSend(ctx, g, `${w === 'x' ? '❌' : '⭕'} @${ctx.senderNum} wins.`); }
        if (g.board.every(Boolean)) { tttGames.delete(ctx.jid); return tttSend(ctx, g, 'Draw. Boring.'); }
        g.turn = mark === 'x' ? 'o' : 'x';
        return tttSend(ctx, g, `${g.turn === 'x' ? '❌' : '⭕'} @${g.turn === 'x' ? g.x : g.o}, your move. (${P()}ttt <1-9>)`);
      }
      if (g) return ctx.reply(`A game is already running here. ${P()}ttt end stops it.`);
      const target = ctx.mentioned[0] || ctx.ctxInfo?.participant;
      if (!target) return ctx.reply(`Tag who you want to play.\nExample: ${P()}ttt @user`);
      const o = numberOf(target);
      if (botNumbers(ctx.sock).includes(o)) return ctx.reply("I don't play. I'd win and you'd sulk.");
      if (o === ctx.senderNum) return ctx.reply('Playing yourself? Pick someone else.');
      const game = { x: ctx.senderNum, o, xJid: ctx.sender, oJid: target, board: Array(9).fill(null), turn: 'x', at: Date.now() };
      tttGames.set(ctx.jid, game);
      return tttSend(ctx, game, `❌ @${game.x} vs ⭕ @${game.o}\n@${game.x} starts. Play with ${P()}ttt <1-9>`);
    },
  },
  {
    name: 'hangman', aliases: ['hm'], category: 'GAMES', menu: ['hangman', 'hangman <letter>'],
    run: (ctx) => {
      const a = (ctx.args[0] || '').toLowerCase();
      const g = live(hangGames, ctx.jid);
      if (a === 'end' || a === 'stop') {
        if (!g) return ctx.reply('No game running.');
        hangGames.delete(ctx.jid);
        return ctx.reply(`It was "${g.word}".`);
      }
      if (!a) {
        if (g) return ctx.reply(`${hangView(g)}\nGuess with ${P()}hangman <letter>`);
        const ng = { word: pick(WORDS), guessed: new Set(), wrong: 0, wrongLetters: [], at: Date.now() };
        hangGames.set(ctx.jid, ng);
        return ctx.reply(`${hangView(ng)}\nGuess with ${P()}hangman <letter> (or the whole word)`);
      }
      if (!/^[a-z]+$/.test(a)) return ctx.reply('Letters only.');
      if (!g) return ctx.reply(`No game running. Start one with ${P()}hangman`);
      g.at = Date.now();
      if (a.length > 1) {
        if (a === g.word) { hangGames.delete(ctx.jid); win(ctx); return ctx.reply(`"${g.word}". Yes. Got it in one.`); }
        g.wrong += 1;
      } else {
        if (g.guessed.has(a) || g.wrongLetters.includes(a)) return ctx.reply('Already tried that one.');
        if (g.word.includes(a)) g.guessed.add(a); else { g.wrong += 1; g.wrongLetters.push(a); }
      }
      if ([...g.word].every((c) => g.guessed.has(c))) { hangGames.delete(ctx.jid); win(ctx); return ctx.reply(`"${g.word}". Solved. Fine.`); }
      if (g.wrong >= HANG_MAX) { hangGames.delete(ctx.jid); return ctx.reply(`Dead. It was "${g.word}".`); }
      return ctx.reply(hangView(g));
    },
  },
  {
    name: 'top', aliases: ['leaderboard', 'gamescore'], category: 'GAMES', menu: ['top'],
    run: (ctx) => {
      const t = topWins(10);
      if (!t.length) return ctx.reply('Nobody has won anything yet.');
      return ctx.reply(`*Game wins*\n${t.map((w, i) => `${i + 1}. ${w.name || w.num}: ${w.n}`).join('\n')}`);
    },
  },

  // UTILITY
  {
    name: 'afk', category: 'UTILITY', menu: ['afk [reason]'],
    run: (ctx) => {
      const reason = (ctx.argText || 'No reason given').slice(0, 120);
      S.setAfk(ctx.senderNum, { reason, since: Date.now(), name: ctx.pushName || '' });
      return ctx.reply(`Fine. You're AFK: ${reason}\nI'll tell anyone who tags you. Send any message when you're back.`);
    },
  },

  // OWNER
  {
    // .d 5s (reply to a message): deletes it after the time. Lumi's own messages always work;
    // other people's only in groups where Lumi is admin. Timers are lost on restart.
    name: 'd', category: 'OWNER', menu: ['d <time>'], ownerOnly: true,
    run: async (ctx) => {
      const ms = parseDuration(ctx.args[0]);
      const q = ctx.ctxInfo;
      if (!ms || !q?.stanzaId) return ctx.reply(`Reply to a message and give a time.\nExample: ${S.prefix()}d 5s  (1s to 6h)`);
      const mine = sentIds.has(q.stanzaId) || Boolean(q.participant && botNumbers(ctx.sock).includes(numberOf(q.participant)));
      const key = { remoteJid: ctx.jid, id: q.stanzaId, fromMe: mine, ...(mine || !q.participant ? {} : { participant: q.participant }) };
      await ctx.sock.sendMessage(ctx.jid, { react: { text: '⏱️', key: ctx.msg.key } }).catch(() => {});
      const t = setTimeout(async () => {
        await ctx.sock.sendMessage(ctx.jid, { delete: key }).catch(() => {});
        await ctx.sock.sendMessage(ctx.jid, { delete: ctx.msg.key }).catch(() => {});
      }, ms);
      if (t.unref) t.unref();
    },
  },
  { name: 'sleep', category: 'OWNER', menu: ['sleep'], ownerOnly: true, run: async (ctx) => { S.setSleep(ctx.jid, true); await ctx.reply(SLEEP_LINE); } },
  { name: 'wake', category: 'OWNER', menu: ['wake'], ownerOnly: true, run: (ctx) => ctx.reply("I'm awake. Unfortunately.") },
  {
    // Hidden. Usage: .claim <passphrase>  (private chat only). Stores your phone number AND hidden id (LID).
    name: 'claim', category: 'OWNER', hidden: true,
    run: async (ctx) => {
      if (!CONFIG.claimPassphrase) return ctx.reply('Claiming is switched off.');
      if (ctx.isGroup) return ctx.reply('Not here. Message me privately. And change that passphrase now; everyone just saw it.');
      if (tooManyAttempts(ctx.senderNum)) return ctx.reply('Too many tries. Come back later.');
      const ok = ctx.argText && crypto.timingSafeEqual(sha(ctx.argText), sha(CONFIG.claimPassphrase));
      if (!ok) { claimAttempts.get(ctx.senderNum).n += 1; return ctx.reply('No.'); }
      S.addClaimed(senderIds(ctx.msg));
      return ctx.reply(`Okay. You're ${CONFIG.ownerName}. I'll remember.`);
    },
  },
  {
    name: 'unclaim', category: 'OWNER', hidden: true, mainOwnerOnly: true,
    run: (ctx) => { S.clearClaimed(); return ctx.reply('Cleared every claimed owner. Only the ids in my settings remain.'); },
  },
  {
    name: 'addsubowner', category: 'OWNER', menu: ['addsubowner @user'], mainOwnerOnly: true,
    run: (ctx) => {
      const t = targetNumbers(ctx);
      if (!t.length) return ctx.reply(`Tag them, reply to their message, or type their number.\nExample: ${S.prefix()}addsubowner @user`);
      if (t.every(S.isMainOwner)) return ctx.reply("That one's already the owner.");
      return ctx.reply(S.addSubOwners(t) ? "Done. They can use owner commands now. Don't make me regret it." : 'They already have that.');
    },
  },
  {
    name: 'delsubowner', category: 'OWNER', menu: ['delsubowner @user'], mainOwnerOnly: true,
    run: (ctx) => {
      const t = targetNumbers(ctx);
      if (!t.length) return ctx.reply(`Tag them, reply to their message, or type their number.\nExample: ${S.prefix()}delsubowner @user`);
      return ctx.reply(S.removeSubOwners(t) ? 'Removed. Back to normal person.' : "They weren't a sub-owner.");
    },
  },
  {
    name: 'setprefix', category: 'OWNER', menu: ['setprefix <symbol>'], ownerOnly: true,
    run: (ctx) => {
      const cur = S.prefix(), p = ctx.args[0];
      if (!p) return ctx.reply(`Current prefix: ${cur}\nUse: ${cur}setprefix ! (or "reset")`);
      if (p.toLowerCase() === 'reset') { S.setPrefix(null); return ctx.reply(`Prefix reset to ${S.prefix()}`); }
      if (p.length > 2 || /[a-z0-9\s]/i.test(p)) return ctx.reply('Use 1 or 2 symbols, like ! # $ or .');
      S.setPrefix(p);
      return ctx.reply(`Prefix is now ${p}\nExample: ${p}menu`);
    },
  },
  {
    name: 'setprofilepic', category: 'OWNER', menu: ['setprofilepic'], ownerOnly: true,
    run: async (ctx) => {
      const media = findMedia(ctx.msg, ['image']);
      if (!media) return ctx.reply('Reply to an image with this command, or send an image with it as the caption.');
      if (Number(media.node.fileLength) > 10 * 1024 * 1024) return ctx.reply('That image is too big (10 MB max).');
      await ctx.sock.updateProfilePicture(jidNormalizedUser(ctx.sock.user.id), await downloadMedia(ctx.sock, media.source));
      return ctx.reply('Done. New face.');
    },
  },
  { name: 'vv', aliases: ['damn', 'viewonce', 'reveal', 'vo'], category: 'OWNER', menu: ['vv'], ownerOnly: true, run: (ctx) => revealViewOnce(ctx, false) },
  { name: 'vv2', aliases: ['cute'], category: 'OWNER', menu: ['vv2'], ownerOnly: true, run: (ctx) => revealViewOnce(ctx, true) },
  {
    name: 'resetaffinity', aliases: ['affinityreset', 'affinityres'], category: 'OWNER', menu: ['resetaffinity @user', 'resetaffinity all'], ownerOnly: true,
    run: (ctx) => {
      if ((ctx.args[0] || '').toLowerCase() === 'all') {
        if (!ctx.isMainOwner) return ctx.reply('Only the main owner can wipe everyone.');
        const c = resetAllAffinity();
        return ctx.reply(`Done. ${c} ${c === 1 ? 'person is' : 'people are'} back to stranger.`);
      }
      const t = targetNumbers(ctx);
      if (!t.length) return ctx.reply(`Tag them, reply to their message, or type their number.\nExample: ${S.prefix()}resetaffinity @user\nEveryone: ${S.prefix()}resetaffinity all`);
      return ctx.reply(resetAffinity(t) ? 'Done. Back to stranger.' : 'They had nothing to reset.');
    },
  },
];

const RECAP_SYSTEM =
  'You summarise a WhatsApp group chat for someone who missed it. Sound like Lumi: dry, short, no fluff.\n' +
  'Format: one headline line saying what the chat was about, then at most 6 lines that each start with "• " ' +
  '(who said or decided what, plans, open questions). Plain text, no markdown, no intro, no outro. ' +
  'Only use what is in the chat; never invent details. Under 900 characters. Write in the language the chat uses.';
const recapAt = new Map();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const claimAttempts = new Map();
function tooManyAttempts(num) {
  const now = Date.now(), a = claimAttempts.get(num);
  if (!a || now - a.first > 3600000) { claimAttempts.set(num, { n: 0, first: now }); return false; }
  return a.n >= 5;
}

// ---------- registry + menu ----------

const byName = new Map();
for (const cmd of commandList) {
  byName.set(cmd.name, cmd);
  (cmd.aliases || []).forEach((a) => byName.set(a, cmd));
}
const MENU_ORDER = ['GENERAL', 'AI SYSTEM', 'STICKER TOOLS', 'MEDIA', 'DOWNLOAD', 'PROFILE', 'GROUP TOOLS', 'GAMES', 'UTILITY', 'OWNER'];

const EMOJI = {'GENERAL':'🛠','AI SYSTEM':'🧠','STICKER TOOLS':'🎭','MEDIA':'🎧','DOWNLOAD':'📥','PROFILE':'👤','GROUP TOOLS':'👥','GAMES':'🎮','UTILITY':'🧰','OWNER':'👑'};
const PER_LINE = 4;
// Layout: bold section titles with an emoji, command names only (no arguments), 4 per line.
function renderMenu(groups, cats, prefix, status, footer) {
  const out = ['*LUMI* 🤍', `_${status}_`, ''];
  for (const cat of cats) {
    const names = [...new Set(groups.get(cat).map((e) => String(e).trim().split(/\s+/)[0]))].map((n) => `${prefix}${n}`);
    out.push(`*${EMOJI[cat] || '✨'} ${cat}*`);
    for (let i = 0; i < names.length; i += PER_LINE) out.push(names.slice(i, i + PER_LINE).join('  '));
    out.push('');
  }
  out.push(`_${footer}_`);
  return out.join('\n');
}

function buildMenu() {
  const prefix = S.prefix();
  const groups = new Map();
  for (const c of commandList) {
    if (c.hidden) continue;
    if (!groups.has(c.category)) groups.set(c.category, []);
    for (const e of c.menu || [c.name]) groups.get(c.category).push(e);
  }
  const cats = [...MENU_ORDER.filter((c) => groups.has(c)), ...[...groups.keys()].filter((c) => !MENU_ORDER.includes(c))];
  return renderMenu(groups, cats, prefix, `Online · ${label()}`, CONFIG.personality === 'warm' || !['maki', 'calm'].includes(CONFIG.personality) ? "Pick a command. I'm listening." : 'Choose a command. I suppose.');
}

// ---------- parsing: prefixed commands for everyone, prefix-free for owners ----------

// Recovery commands also answer to the default prefix, so a forgotten custom prefix never locks anyone out.
const RECOVERY = new Set(['setprefix', 'claim', 'wake']);
const hasNumber = (a) => a.some((x) => { const d = x.replace(/\D/g, ''); return d.length >= 7 && d.length <= 15; });
const hasTarget = (ctx) => ctx.mentioned.length > 0 || Boolean(ctx.ctxInfo?.participant);
const hasMedia = (ctx, kinds) => Boolean(findMedia(ctx.msg, kinds));
const onOff = (a) => /^(?:on|off)$/i.test(a[0] || '');
// 'exact' = message is just the word; 'rest' = word + free text; functions = needs a real target / number / media.
const NO_PREFIX = {
  menu: 'exact', help: 'exact', ping: 'exact', about: 'exact', status: 'exact', owner: 'exact', clear: 'exact',
  afk: 'rest', play: 'rest',
  chatbot: (a) => onOff(a), protect: (a) => onOff(a),
  setprefix: (a) => a.length === 1 && (a[0].toLowerCase() === 'reset' || /^[^a-z0-9\s]{1,2}$/i.test(a[0])),
  add: (a) => hasNumber(a),
  kick: (a, ctx) => hasTarget(ctx),
  getpp: (a, ctx) => hasTarget(ctx),
  addsubowner: (a, ctx) => hasTarget(ctx) || hasNumber(a),
  delsubowner: (a, ctx) => hasTarget(ctx) || hasNumber(a),
  creategc: (a) => a.length > 0,
  jail: (a, ctx) => hasTarget(ctx),
  unjail: (a, ctx) => hasTarget(ctx) || /^all$/i.test(a[0] || ''),
  jailed: 'exact',
  gcpp: 'exact',
  poll: (a) => a.join(' ').includes('|'),
  gclink: 'rest',
  d: (a, ctx) => /^\d+\s*(?:s|sec|m|min|h|hr)?$/i.test(a[0] || '') && Boolean(ctx.ctxInfo?.stanzaId),
  s: (a, ctx) => hasMedia(ctx, ['image', 'video']),
  take: (a, ctx) => hasMedia(ctx, ['sticker']),
  toimg: (a, ctx) => hasMedia(ctx, ['sticker']),
  setprofilepic: (a, ctx) => hasMedia(ctx, ['image']),
};

function parsePrefixed(text) {
  const custom = S.prefix();
  let body;
  if (text.startsWith(custom)) body = text.slice(custom.length);
  else if (custom !== CONFIG.prefix && text.startsWith(CONFIG.prefix)) body = text.slice(CONFIG.prefix.length);
  else return null;
  const [name, ...args] = body.trim().split(/\s+/);
  const cmd = byName.get((name || '').toLowerCase());
  if (!cmd) return null;
  if (!text.startsWith(custom) && !RECOVERY.has(cmd.name)) return null;
  return { cmd, args };
}
function parseNoPrefix(text, ctx) {
  if (!ctx.isOwner) return null;
  const stripped = text.replace(/^\s*(?:hey\s+)?lumi[\s,:;-]+/i, '');
  const startedWithName = stripped !== text;
  const [word, ...args] = stripped.trim().split(/\s+/);
  const cmd = byName.get((word || '').toLowerCase().replace(/[.,!?]+$/, ''));
  const rule = cmd && NO_PREFIX[cmd.name];
  if (!rule) return null;
  const addressed = !ctx.isGroup || startedWithName || Boolean(ctx.addressed);
  if (rule === 'exact') return args.length === 0 && addressed ? { cmd, args } : null;
  if (rule === 'rest') return (cmd.name !== 'play' || args.length > 0) && addressed ? { cmd, args } : null;
  return rule(args, ctx) ? { cmd, args } : null;
}
const parse = (text, ctx) => parsePrefixed(text) || parseNoPrefix(text, ctx);

// ---------- AFK ----------

const afkNoticeAt = new Map();
async function afkHandling(ctx, isAfkCommand) {
  const mine = S.getAfk(ctx.senderNum);
  if (mine && !isAfkCommand) {
    S.clearAfk(ctx.senderNum);
    await ctx.reply(`Back already? You were gone ${fmtDuration(Date.now() - mine.since)}.`);
  }
  if (!ctx.isGroup) return;
  const targets = uniq([...ctx.mentioned, ctx.ctxInfo?.participant].filter(Boolean).map(numberOf));
  for (const n of targets) {
    const afk = S.getAfk(n);
    if (!afk || n === ctx.senderNum) continue;
    const key = `${ctx.jid}:${n}`;
    if (Date.now() - (afkNoticeAt.get(key) || 0) < 5 * 60 * 1000) continue;
    afkNoticeAt.set(key, Date.now());
    await ctx.reply(`${afk.name || 'They'} is AFK: ${afk.reason} (${fmtDuration(Date.now() - afk.since)} ago).`);
  }
}

// ---------- entry points ----------

const seen = new Map();
function isDuplicate(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, Date.now());
  if (seen.size > 2000) for (const k of seen.keys()) { seen.delete(k); if (seen.size <= 1500) break; }
  return false;
}

function buildCtx(sock, msg) {
  const jid = msg.key.remoteJid;
  const m = unwrap(msg.message);
  const ctxInfo = getContext(m);
  const sender = msg.key.participant || jid;
  const ctx = {
    sock, msg, m, jid, sender, ctxInfo,
    senderNum: numberOf(sender),
    text: getText(m).trim(),
    isGroup: jid.endsWith('@g.us'),
    pushName: msg.pushName || '',
    mentioned: ctxInfo?.mentionedJid || [],
    reply: (t, extra = {}) => sock.sendMessage(jid, { text: t, ...extra }, { quoted: msg }),
  };
  ctx.isOwner = S.isOwner(ctx.senderNum);
  ctx.isMainOwner = S.isMainOwner(ctx.senderNum);
  ctx.addressed = isAddressed(ctx);
  return ctx;
}

// Returns true when Lumi handled the message (command, AFK-only chatter excluded, sleep, Divine protection).
async function handleCommand(sock, msg) {
  trackSent(sock);
  if (!msg || !msg.message || msg.key.fromMe) return false; // Lumi runs on her OWN number
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return false;
  if (isDuplicate(msg.key.id)) return false;
  const ts = Number(msg.messageTimestamp) || 0;
  if (ts && Date.now() / 1000 - ts > 120) return false; // old backlog after reconnect
  const m = unwrap(msg.message);
  if (!m || m.protocolMessage || m.reactionMessage || (m.senderKeyDistributionMessage && Object.keys(m).length === 1)) return false;

  learnAliases(msg);
  vaultRemember(sock, msg).catch(() => {}); // keep view-once messages so .vv works later
  const ctx = buildCtx(sock, msg);
  if (ctx.isGroup && (await jailCheck(ctx))) return true; // jailed: message deleted, nothing else runs
  const parsed = parse(ctx.text, ctx);
  const isAfkCommand = Boolean(parsed && parsed.cmd.name === 'afk');

  if (ctx.isGroup && ctx.text && !parsed) logChat(jid, ctx.pushName || ctx.senderNum, ctx.text);

  // Sleep: asleep = total silence in this chat, except the owner waking her up.
  const wantsWake = ctx.isOwner && (WAKE_RE.test(ctx.text) || Boolean(parsed && parsed.cmd.name === 'wake'));
  if (S.isAsleep(jid)) {
    if (wantsWake) { S.setSleep(jid, false); await ctx.reply("Yeah, yeah. I'm up."); }
    return true;
  }
  if (ctx.isOwner && SLEEP_RE.test(ctx.text)) { S.setSleep(jid, true); await ctx.reply(SLEEP_LINE); return true; }

  await afkHandling(ctx, isAfkCommand).catch((e) => warn('AFK handling failed:', e.message));

  if (parsed) {
    const { cmd, args } = parsed;
    ctx.args = args;
    ctx.argText = args.join(' ');
    try {
      if (cmd.mainOwnerOnly && !ctx.isMainOwner) await ctx.reply('Only the main owner can do that.');
      else if (cmd.ownerOnly && !ctx.isOwner) await ctx.reply('That one is for the owner only.');
      else await cmd.run(ctx);
    } catch (e) {
      warn(`command ${cmd.name} failed:`, e.message);
      await ctx.reply("That didn't work. Try again in a bit.").catch(() => {});
    }
    return true;
  }

  // Divine protection: react + reply when the protected person is @mentioned in a group.
  const protect = divineCheck(ctx);
  if (protect) {
    if (protect.emoji) await sock.sendMessage(jid, { react: { text: protect.emoji, key: msg.key } }).catch(() => {});
    await ctx.reply(protect.reply);
    return true;
  }
  return false;
}

// Should the host's AI answer this message? (AI on for the chat + Lumi addressed in groups + has text)
function shouldChat(sock, msg) {
  const ctx = buildCtx(sock, msg);
  return Boolean(ctx.text) && S.isAiOn(ctx.jid) && isAddressed(ctx);
}
const isAiOn = (jid) => S.isAiOn(jid);

module.exports = {
  handleCommand, shouldChat, isAiOn, configure, buildMenu,
  gainAffinity, getAffinity, isOwner: (num) => S.isOwner(digits(num)), ownerName: CONFIG.ownerName,
  parse, winnerOf, isPrivateIp, parseYoutube, pickVideo, // exported for tests
};
