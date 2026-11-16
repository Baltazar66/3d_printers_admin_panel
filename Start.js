#!/usr/bin/env node
/**
 * Запуск сканера 3D-принтеров:
 *  1. Поднимает HTTP-сервер на localhost:8000 (отдаёт HTML)
 *  2. Проксирует /proxy?url=... к Moonraker (обход CORS)
 *  3. Управляет умными розетками Tuya через Cloud API
 *  4. Периодически опрашивает статус розеток
 *  5. Отдаёт конфиг сканирования из devices.json
 *  6. Открывает браузер
 *
 * Запуск:  node start.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const PORT = 8000;
const HTML_FILE = '3d printers main.html';
const DEVICES_FILE = 'devices.json';
const ROOT = __dirname;

// ---------------------------------------------------------------
// Загрузка настроек
// ---------------------------------------------------------------
let plugConfigs = [];
let tuyaContext = null;
let scanConfig = {
    ip_range: '192.168.0.1-254',
    rescan_after_plug_on_sec: 90,
};
let plugPollSec = 15;

function loadConfig() {
    const file = path.join(ROOT, DEVICES_FILE);
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);

        // Облако
        const cloud = data.tuya_cloud || {};
        if (!cloud.access_id || !cloud.access_secret) {
            console.error(`В ${DEVICES_FILE} не заданы tuya_cloud.access_id / access_secret.`);
            tuyaContext = null;
        } else {
            tuyaContext = new TuyaContext({
                baseUrl: cloud.base_url || 'https://openapi.tuyaeu.com',
                accessKey: cloud.access_id,
                secretKey: cloud.access_secret,
            });
            console.log(`Tuya Cloud: ${cloud.base_url || 'https://openapi.tuyaeu.com'}`);
        }

        // Сканирование
        const scan = data.scan || {};
        if (typeof scan.ip_range === 'string' && scan.ip_range.trim()) {
            scanConfig.ip_range = scan.ip_range.trim();
        }
        if (typeof scan.rescan_after_plug_on_sec === 'number' && scan.rescan_after_plug_on_sec > 0) {
            scanConfig.rescan_after_plug_on_sec = scan.rescan_after_plug_on_sec;
        }
        console.log(`Сканирование: диапазон по умолчанию ${scanConfig.ip_range}, ресканирование после ВКЛ через ${scanConfig.rescan_after_plug_on_sec} с`);

        // Опрос розеток
        if (typeof data.plug_poll_sec === 'number' && data.plug_poll_sec > 0) {
            plugPollSec = data.plug_poll_sec;
        }
        console.log(`Опрос розеток: каждые ${plugPollSec} с`);

        // Розетки
        plugConfigs = Array.isArray(data.plugs) ? data.plugs : [];
        console.log(`Загружено розеток из ${DEVICES_FILE}: ${plugConfigs.length}`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log(`Файл ${DEVICES_FILE} не найден — используются настройки по умолчанию.`);
        } else {
            console.error(`Ошибка чтения ${DEVICES_FILE}:`, err.message);
        }
        plugConfigs = [];
        tuyaContext = null;
    }
}

// ---------------------------------------------------------------
// Состояние розеток: id -> { config, state }
// ---------------------------------------------------------------
const plugs = new Map();

// Запрос статуса устройства через прямой вызов API
async function fetchDeviceStatus(deviceId) {
    return await tuyaContext.request({
        method: 'GET',
        path: `/v1.0/iot-03/devices/${deviceId}/status`,
    });
}

// Читает статус одной розетки с ретраем
async function readPlugState(cfg, attempts = 5, delayMs = 1500) {
    const switchCode = cfg.switch_code || 'switch_1';
    for (let i = 0; i < attempts; i++) {
        try {
            const st = await fetchDeviceStatus(cfg.id);
            if (st.success && Array.isArray(st.result) && st.result.length > 0) {
                const dp = st.result.find(d => d.code === switchCode);
                if (dp) return !!dp.value;
                console.warn(`[plug ${cfg.name || cfg.id}] DP "${switchCode}" не найден. Доступные:`,
                    st.result.map(d => d.code).join(', '));
                return null;
            }
            console.log(`[plug ${cfg.name || cfg.id}] attempt ${i + 1}: пустой result, ждём...`);
        } catch (e) {
            console.warn(`[plug ${cfg.name || cfg.id}] attempt ${i + 1} error:`, e.message);
        }
        if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
}

async function initPlugs() {
    if (!tuyaContext) {
        console.warn('Tuya Cloud не инициализирован — розетки пропущены.');
        return;
    }

    // Прогрев: получаем токен доступа
    try {
        await tuyaContext.request({ method: 'GET', path: '/v1.0/token?grant_type=1' });
        console.log('Tuya Cloud: токен получен.');
    } catch (e) {
        console.warn('Tuya Cloud: не удалось получить токен:', e.message);
    }
    await new Promise(r => setTimeout(r, 1000));

    for (const cfg of plugConfigs) {
        if (!cfg.id) {
            console.warn(`Пропущена розетка без id: ${JSON.stringify(cfg)}`);
            continue;
        }
        try {
            const res = await tuyaContext.device.detail({ device_id: cfg.id });
            if (!res.success) {
                console.error(`Розетка "${cfg.name || cfg.id}" недоступна: ${res.msg || 'unknown'}`);
                continue;
            }

            const state = await readPlugState(cfg);
            plugs.set(cfg.id, { config: cfg, state });
            console.log(`Розетка "${cfg.name || cfg.id}" доступна через облако, состояние: ${state}`);
        } catch (err) {
            console.error(`Ошибка проверки розетки "${cfg.name || cfg.id}":`, err.message);
        }
    }
}

// ---------------------------------------------------------------
// Периодический опрос всех розеток
// ---------------------------------------------------------------
let pollTimer = null;

async function pollAllPlugs() {
    if (!tuyaContext) return;
    for (const [id, plug] of plugs) {
        const switchCode = plug.config.switch_code || 'switch_1';
        try {
            const st = await fetchDeviceStatus(id);
            if (st.success && Array.isArray(st.result) && st.result.length > 0) {
                const dp = st.result.find(d => d.code === switchCode);
                if (dp) {
                    const newState = !!dp.value;
                    if (newState !== plug.state) {
                        console.log(`Розетка "${plug.config.name || id}": ${plug.state} → ${newState}`);
                    }
                    plug.state = newState;
                }
            }
        } catch (e) {
            // тихо игнорируем
        }
    }
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollAllPlugs, plugPollSec * 1000);
    console.log(`Запущен периодический опрос розеток (${plugPollSec} с).`);
}

// ---------------------------------------------------------------
// Универсальный JSON-запрос (для проверки Moonraker)
// ---------------------------------------------------------------
async function fetchJson(targetUrl) {
    const r = await fetch(targetUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
}

// ---------------------------------------------------------------
// Проверка, печатает ли принтер
// ---------------------------------------------------------------
async function isPrinterPrinting(printerIp) {
    if (!printerIp) return false;
    try {
        const q = await fetchJson(`http://${printerIp}:7125/printer/objects/query?print_stats`);
        const st = q?.result?.status?.print_stats?.state;
        return st === 'printing' || st === 'paused';
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------
// HTTP-сервер
// ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // --- Прокси ---
    if (url.pathname === '/proxy') {
        const target = url.searchParams.get('url');
        if (!target) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing ?url=');
        }

        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Invalid target URL');
        }

        const host = targetUrl.hostname;
        const isLocal =
            host === 'localhost' ||
            host === '127.0.0.1' ||
            /^10\./.test(host) ||
            /^192\.168\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host);
        if (!isLocal) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('Only local network targets allowed');
        }

        const lib = targetUrl.protocol === 'https:' ? require('https') : http;
        const proxyReq = lib.request(
            targetUrl,
            { method: req.method, headers: { 'Accept': 'application/json' } },
            (proxyRes) => {
                res.writeHead(proxyRes.statusCode || 502, {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': proxyRes.headers['content-type'] || 'application/json',
                    'Cache-Control': 'no-store',
                });
                proxyRes.pipe(res);
            }
        );
        proxyReq.on('error', (err) => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            }
            res.end(JSON.stringify({ error: 'proxy_error', message: err.message }));
        });
        req.pipe(proxyReq);
        return;
    }

    // --- Конфиг ---
    if (url.pathname === '/api/config') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        return res.end(JSON.stringify({
            ip_range: scanConfig.ip_range,
            rescan_after_plug_on_sec: scanConfig.rescan_after_plug_on_sec,
        }));
    }

    // --- Список розеток ---
    if (url.pathname === '/api/plugs') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        const list = [];
        for (const cfg of plugConfigs) {
            const p = plugs.get(cfg.id);
            list.push({
                id: cfg.id,
                name: cfg.name || cfg.id,
                printer_ip: cfg.printer_ip || null,
                state: p ? p.state : null,
                connected: !!p,
            });
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ plugs: list }));
    }

    // --- Команды розетке ---
    if (url.pathname === '/api/plug') {
        const id = url.searchParams.get('id');
        const action = url.searchParams.get('action'); // on | off | status

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        if (!id) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Не указан id розетки' }));
        }
        const plug = plugs.get(id);
        if (!plug) {
            res.writeHead(404);
            return res.end(JSON.stringify({ error: `Розетка ${id} не подключена` }));
        }
        if (!tuyaContext) {
            res.writeHead(503);
            return res.end(JSON.stringify({ error: 'Tuya Cloud не инициализирован' }));
        }

        const switchCode = plug.config.switch_code || 'switch_1';

        try {
            if (action === 'status') {
                const state = await readPlugState(plug.config);
                if (state !== null) plug.state = state;
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, state: plug.state }));
            }

            if (action === 'on' || action === 'off') {
                const desired = action === 'on';

                if (!desired && plug.config.printer_ip) {
                    const printing = await isPrinterPrinting(plug.config.printer_ip);
                    if (printing) {
                        res.writeHead(409);
                        return res.end(JSON.stringify({ error: 'Печать идёт — выключение запрещено' }));
                    }
                }

                const cmd = await tuyaContext.request({
                    method: 'POST',
                    path: `/v1.0/iot-03/devices/${id}/commands`,
                    body: { commands: [{ code: switchCode, value: desired }] }
                });

                if (!cmd.success) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ error: cmd.msg || 'Ошибка облака' }));
                }

                const realState = await readPlugState(plug.config);
                plug.state = realState !== null ? realState : desired;

                const response = { success: true, state: plug.state, requested: desired };
                if (desired) {
                    response.rescan_after_sec = scanConfig.rescan_after_plug_on_sec;
                }
                res.writeHead(200);
                return res.end(JSON.stringify(response));
            }

            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Неизвестное действие' }));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // --- Статика ---
    let filePath;
    if (url.pathname === '/' || url.pathname === '/index.html') {
        filePath = path.join(ROOT, HTML_FILE);
    } else {
        filePath = path.join(ROOT, decodeURIComponent(url.pathname));
    }

    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Not found: ' + url.pathname);
        }
        const ext = path.extname(filePath).toLowerCase();
        const types = {
            '.html': 'text/html; charset=utf-8',
            '.js':   'application/javascript; charset=utf-8',
            '.css':  'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png':  'image/png',
            '.jpg':  'image/jpeg',
            '.svg':  'image/svg+xml',
            '.ico':  'image/x-icon',
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

// ---------------------------------------------------------------
// Открытие браузера
// ---------------------------------------------------------------
function openBrowser(url) {
    const platform = process.platform;
    let cmd;
    if (platform === 'win32') {
        cmd = `rundll32 url.dll,FileProtocolHandler "${url}"`;
    } else if (platform === 'darwin') {
        cmd = `open "${url}"`;
    } else {
        cmd = `xdg-open "${url}"`;
    }
    exec(cmd, (err) => {
        if (err) {
            console.log('Не удалось открыть браузер автоматически.');
            console.log(`Откройте вручную: ${url}`);
        }
    });
}

// ---------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, HTML_FILE))) {
    console.error(`❌ Файл "${HTML_FILE}" не найден в папке ${ROOT}`);
    process.exit(1);
}

loadConfig();

server.listen(PORT, '127.0.0.1', async () => {
    const url = `http://localhost:${PORT}/`;
    console.log('┌─────────────────────────────────────────────────┐');
    console.log('│  Сканер 3D-принтеров // Moonraker               │');
    console.log('├─────────────────────────────────────────────────┤');
    console.log(`│  Сервер:   ${url.padEnd(35)}│`);
    console.log(`│  Прокси:   http://localhost:${PORT}/proxy?url=… │`);
    console.log(`│  HTML:     ${HTML_FILE.padEnd(35)}│`);
    console.log('└─────────────────────────────────────────────────┘');
    console.log('');
    await initPlugs();
    startPolling();
    console.log('');
    console.log('Открываю браузер...');
    openBrowser(url);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Порт ${PORT} уже занят.`);
    } else {
        console.error('❌ Ошибка сервера:', err.message);
    }
    process.exit(1);
});