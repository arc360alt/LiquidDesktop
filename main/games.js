// The Games app's library: every game on this computer, from wherever it came from —
//  - Steam (native or Flatpak): installed games (steamapps/appmanifest_*.acf in every library folder), your playtime and
//    when you last played (userdata/<you>/config/localconfig.vdf), and achievements from your public Steam profile
//    (steamcommunity.com/profiles/<id>/stats/<app>/achievements?xml=1) with how rare each is (Steam's global
//    percentages) — no API key needed; a private profile just shows no achievements
//  - Heroic (Epic, GOG, and games added to it), native or Flatpak, with its playtime
//  - Lutris (its database), native or Flatpak
//  - any other installed app that calls itself a game (Flatpak or your distribution's packages: Categories=Game)
// Launching goes through each launcher (steam://rungameid/…, heroic://launch…, lutris:rungame/…).
const { ipcMain, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const HOME = os.homedir();
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
const which = (c) => (process.env.PATH || '').split(':').some((d) => exists(path.join(d, c)));

/** Valve's text KeyValues (VDF): { "key" "value" } and nested { }. Keys compared lower-case-insensitively by callers. */
function vdf(text) {
  const root = {}, stack = [root];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let m, key = null;
  while ((m = re.exec(text || ''))) {
    const cur = stack[stack.length - 1];
    if (m[2] === '{') { const o = {}; cur[key] = o; stack.push(o); key = null; }
    else if (m[2] === '}') { stack.pop(); key = null; if (!stack.length) break; }
    else if (key === null) key = m[1];
    else { cur[key] = m[1].replace(/\\(.)/g, '$1'); key = null; }
  }
  return root;
}
const ci = (o, k) => (o ? o[Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase())] : undefined);

/* ------------------------------------------------------------------ Steam */
const STEAM_ROOTS = [
  { root: path.join(HOME, '.local/share/Steam'), flatpak: false },
  { root: path.join(HOME, '.steam/steam'), flatpak: false },
  { root: path.join(HOME, '.var/app/com.valvesoftware.Steam/.local/share/Steam'), flatpak: true },
  { root: path.join(HOME, '.var/app/com.valvesoftware.Steam/data/Steam'), flatpak: true },
];
// Steam's own tools, not games
const STEAM_TOOLS = /^(Proton\b|Steam Linux Runtime|Steamworks Common Redistributables|SteamVR\b|Steam Audio)/i;
const steamUser = (root) => {
  const users = ci(vdf(read(path.join(root, 'config/loginusers.vdf'))), 'users') || {};
  const ids = Object.keys(users);
  const id = ids.find((k) => ci(users[k], 'MostRecent') === '1') || ids[0];
  return id ? { id64: id, name: ci(users[id], 'PersonaName') || ci(users[id], 'AccountName') } : null;
};
function steamGames() {
  const out = new Map();
  for (const { root, flatpak } of STEAM_ROOTS) {
    const real = (() => { try { return fs.realpathSync(root); } catch { return null; } })();
    if (!real || !exists(path.join(real, 'steamapps'))) continue;
    const user = steamUser(real);
    // playtime and last played, per game
    let local = {};
    if (user) {
      const acc = String(BigInt(user.id64) - 76561197960265728n);
      const cfg = vdf(read(path.join(real, 'userdata', acc, 'config/localconfig.vdf')));
      local = ci(ci(ci(ci(ci(cfg, 'UserLocalConfigStore'), 'Software'), 'Valve'), 'Steam'), 'apps') || {};
    }
    const libs = ci(vdf(read(path.join(real, 'steamapps/libraryfolders.vdf'))), 'libraryfolders') || {};
    const dirs = new Set([path.join(real, 'steamapps')]);
    for (const k of Object.keys(libs)) { const p = ci(libs[k], 'path'); if (p) dirs.add(path.join(p, 'steamapps')); }
    for (const dir of dirs) {
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
      for (const f of files) {
        const a = ci(vdf(read(path.join(dir, f))), 'AppState');
        if (!a) continue;
        const id = ci(a, 'appid'), name = (ci(a, 'name') || '').trim();
        if (!id || !name || STEAM_TOOLS.test(name) || out.has('steam:' + id)) continue;
        const lc = local[id] || {};
        const played = +ci(lc, 'Playtime') || 0;
        out.set('steam:' + id, {
          id: 'steam:' + id, source: 'steam', sourceName: 'Steam', appid: id, name,
          size: +ci(a, 'SizeOnDisk') || 0, installed: (+ci(a, 'StateFlags') & 4) === 4,
          lastPlayed: (+ci(lc, 'LastPlayed') || +ci(a, 'LastPlayed') || 0) * 1000, playtime: played * 60,
          cover: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/library_600x900_2x.jpg`,
          coverAlt: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`,
          hero: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/library_hero.jpg`,
          header: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
          logo: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/logo.png`,
          launch: { kind: 'url', url: `steam://rungameid/${id}`, flatpak: flatpak ? 'com.valvesoftware.Steam' : null },
          storeUrl: `https://store.steampowered.com/app/${id}/`, steamUser: user?.id64 || null, hasAchievements: true,
        });
      }
    }
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ Heroic (Epic, GOG, sideloaded) */
const HEROIC = [{ dir: path.join(HOME, '.config/heroic'), flatpak: null }, { dir: path.join(HOME, '.var/app/com.heroicgameslauncher.hgl/config/heroic'), flatpak: 'com.heroicgameslauncher.hgl' }];
function heroicGames() {
  const out = [];
  for (const { dir, flatpak } of HEROIC) {
    if (!exists(dir)) continue;
    const times = (() => { try { return JSON.parse(read(path.join(dir, 'store/timestamp.json')) || '{}'); } catch { return {}; } })();
    const add = (g, runner, label) => {
      if (!g || !(g.is_installed ?? g.install?.is_installed ?? true)) return;
      const app = g.app_name || g.appName;
      if (!app || out.some((x) => x.id === `heroic:${runner}:${app}`)) return;
      const t = times[app] || {};
      out.push({ id: `heroic:${runner}:${app}`, source: 'heroic', sourceName: label, name: g.title || app, installed: true,
        cover: g.art_cover || g.art_square || null, hero: g.art_background || g.art_cover || null, size: 0,
        lastPlayed: t.lastPlayed ? Date.parse(t.lastPlayed) : 0, playtime: (+t.totalPlayed || 0) * 60,
        launch: { kind: 'url', url: `heroic://launch?appName=${encodeURIComponent(app)}&runner=${runner}`, flatpak } });
    };
    const lib = (f) => { try { return JSON.parse(read(path.join(dir, f)) || 'null'); } catch { return null; } };
    for (const g of lib('store_cache/legendary_library.json')?.library || []) add(g, 'legendary', 'Epic Games');
    for (const g of lib('store_cache/gog_library.json')?.games || lib('gog_store/library.json')?.games || []) add(g, 'gog', 'GOG');
    for (const g of lib('store_cache/nile_library.json')?.library || []) add(g, 'nile', 'Amazon Games');
    for (const g of lib('sideload_apps/library.json')?.games || []) add(g, 'sideload', 'Heroic');
    // older Heroic: Epic's installed list from legendary itself
    const inst = lib('legendaryConfig/legendary/installed.json') || {};
    for (const [app, g] of Object.entries(inst)) add({ app_name: app, title: g.title, is_installed: true }, 'legendary', 'Epic Games');
  }
  return out;
}

/* ------------------------------------------------------------------ Lutris */
const LUTRIS = [{ data: path.join(HOME, '.local/share/lutris'), flatpak: null }, { data: path.join(HOME, '.var/app/net.lutris.Lutris/data/lutris'), flatpak: 'net.lutris.Lutris' }];
async function lutrisGames() {
  const out = [];
  for (const { data, flatpak } of LUTRIS) {
    const db = path.join(data, 'pga.db');
    if (!exists(db)) continue;
    let rows = [];
    try {
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(db, { readOnly: true });
      rows = d.prepare('SELECT name, slug, runner, lastplayed, playtime, installed, service FROM games WHERE installed = 1').all();
      d.close();
    } catch {
      if (which('sqlite3')) rows = await new Promise((res) => execFile('sqlite3', ['-json', '-readonly', db, 'SELECT name, slug, runner, lastplayed, playtime, installed, service FROM games WHERE installed = 1'], (e, o) => { try { res(JSON.parse(o || '[]')); } catch { res([]); } }));
    }
    for (const r of rows) {
      const cover = ['coverart', 'banners'].map((d) => path.join(data, d, `${r.slug}.jpg`)).find(exists) || null;
      out.push({ id: 'lutris:' + r.slug, source: 'lutris', sourceName: 'Lutris', name: r.name, installed: true, size: 0,
        cover: cover ? 'file://' + cover : null, hero: null, lastPlayed: (+r.lastplayed || 0) * 1000, playtime: Math.round((+r.playtime || 0) * 3600), runner: r.runner,
        launch: { kind: 'url', url: `lutris:rungame/${r.slug}`, flatpak } });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ installed apps that are games */
const LAUNCHER_IDS = /^(steam|com\.valvesoftware\.steam|heroic|com\.heroicgameslauncher\.hgl|net\.lutris\.lutris|lutris|com\.usebottles\.bottles|io\.itch\.itch|itch|org\.libretro\.retroarch|retroarch|net\.davidotek\.pupgui2|com\.vysp3r\.protonplus)$/i;
async function appGames() {
  const { listApps } = require('./system');
  let apps = [];
  try { apps = await listApps(); } catch { return { games: [], launchers: [] }; }
  const games = [], launchers = [];
  for (const a of apps) {
    const cats = (a.categories || []).map((c) => c.toLowerCase());
    if (!cats.includes('game')) continue;
    const base = (a.id || '').replace(/^desktop:/, '').replace(/\.desktop$/, '');
    if (LAUNCHER_IDS.test(base) || /\b(steam|heroic|lutris|bottles|itch)\b/i.test(a.name) && cats.includes('game') && !/steam:\/\/rungameid/.test(a.exec || '')) {
      launchers.push({ id: a.id, name: a.name, icon: a.icon, exec: a.exec });
      continue;
    }
    // Steam's own shortcuts for its games: those come from Steam already
    if (/steam:\/\/rungameid\//.test(a.exec || '')) continue;
    const file = a.file || '';
    const flat = /flatpak/.test(file) || /^flatpak run/.test(a.exec || '');
    games.push({ id: 'app:' + a.id, source: flat ? 'flatpak' : 'app', sourceName: flat ? 'Flatpak' : 'Other Games', name: a.name, installed: true, size: 0,
      icon: a.icon || null, cover: null, hero: null, lastPlayed: 0, playtime: 0, launch: { kind: 'exec', exec: a.exec, terminal: !!a.terminal }, desktopFile: file });
  }
  return { games, launchers };
}

/* ------------------------------------------------------------------ the whole library */
let cache = null, cacheAt = 0;
async function library(force) {
  if (cache && !force && Date.now() - cacheAt < 30_000) return cache;
  const [steam, heroic, lutris, apps] = [steamGames(), heroicGames(), await lutrisGames(), await appGames()];
  // the app-games list can include a Heroic/Lutris shortcut for a game already listed: keep one (by name)
  const seen = new Set([...steam, ...heroic, ...lutris].map((g) => g.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const games = [...steam, ...heroic, ...lutris, ...apps.games.filter((g) => !seen.has(g.name.toLowerCase().replace(/[^a-z0-9]/g, '')))];
  games.sort((a, b) => (b.lastPlayed - a.lastPlayed) || a.name.localeCompare(b.name));
  // play times you've had with LiquidDesktop's own counting (Screen Time doesn't know games apart; this does)
  cache = { games, launchers: apps.launchers, sources: [...new Set(games.map((g) => g.sourceName))] };
  cacheAt = Date.now();
  return cache;
}

/** Start a game through its launcher. */
async function launch(id) {
  const g = (await library()).games.find((x) => x.id === id);
  if (!g) throw new Error('That game isn’t installed any more.');
  const { launchEnv, launchExec } = require('./system');
  const L = g.launch;
  if (L.kind === 'exec') return launchExec(L.exec, L.terminal);
  // a launcher's link: through the launcher's Flatpak when it's one, else whatever handles the link
  const c = L.flatpak && which('flatpak') ? spawn('flatpak', ['run', L.flatpak, L.url], { detached: true, stdio: 'ignore', env: launchEnv() })
    : g.source === 'steam' && which('steam') ? spawn('steam', [L.url], { detached: true, stdio: 'ignore', env: launchEnv() })
      : spawn('xdg-open', [L.url], { detached: true, stdio: 'ignore', env: launchEnv() });
  c.on('error', () => {});
  c.unref();
  return true;
}

/* ------------------------------------------------------------------ Steam achievements (public profile, no key) */
const achCache = new Map();   // appid → { at, data }
const fetchText = async (url) => { const r = await net.fetch(url, { headers: { 'User-Agent': 'LiquidDesktop-Games' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); };
const cdata = (s, tag) => { const m = s.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)); return m ? m[1].trim() : ''; };
async function achievements(id) {
  const g = (await library()).games.find((x) => x.id === id);
  if (!g || g.source !== 'steam') return { available: false };
  const hit = achCache.get(g.appid);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  if (!g.steamUser) return { available: false, reason: 'Sign in to Steam to see achievements.' };
  let xml = '';
  try { xml = await fetchText(`https://steamcommunity.com/profiles/${g.steamUser}/stats/${g.appid}/achievements/?xml=1`); }
  catch (e) { return { available: false, reason: 'Couldn’t reach Steam: ' + e.message }; }
  if (/<error>/i.test(xml) && !/<achievement/i.test(xml)) {
    const err = cdata(xml, 'error');
    const data = /private/i.test(err) ? { available: false, reason: 'Your Steam profile’s game details are private. Make them public (Steam › Profile › Edit Profile › Privacy Settings › Game details) to see achievements here.' }
      : { available: false, reason: /stats|achievement/i.test(err) ? 'This game has no achievements.' : err || 'No achievements.' };
    achCache.set(g.appid, { at: Date.now(), data });
    return data;
  }
  const list = [];
  for (const m of xml.matchAll(/<achievement closed="(\d)">([\s\S]*?)<\/achievement>/g)) {
    const b = m[2];
    list.push({ done: m[1] === '1', name: cdata(b, 'name'), desc: cdata(b, 'description'), api: cdata(b, 'apiname'),
      icon: cdata(b, m[1] === '1' ? 'iconClosed' : 'iconOpen'), at: (+cdata(b, 'unlockTimestamp') || 0) * 1000 });
  }
  // how rare each one is (Steam's global percentages, also keyless)
  try {
    const j = JSON.parse(await fetchText(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${g.appid}`));
    const pct = new Map((j.achievementpercentages?.achievements || []).map((a) => [String(a.name).toLowerCase(), +a.percent]));
    for (const a of list) a.rarity = pct.get(a.api.toLowerCase()) ?? null;
  } catch { /* rarity is a bonus */ }
  const hours = +cdata(xml, 'hoursPlayed') || null;
  const data = { available: list.length > 0, reason: list.length ? null : 'This game has no achievements.', list, done: list.filter((a) => a.done).length, total: list.length, hours };
  achCache.set(g.appid, { at: Date.now(), data });
  return data;
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('games:library', library);
  h('games:launch', launch);
  h('games:achievements', achievements);
}
module.exports = { register, library, vdf };
