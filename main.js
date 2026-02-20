const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const Database = require("better-sqlite3");

// =====================================================
// 1️⃣ SET APP NAME FIRST (CRITICAL)
// =====================================================
app.setName("GeoSentinelService");

// Disable GPU completely (prevents cache errors on Windows)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

// =====================================================
// 2️⃣ FORCE SAFE WRITABLE PATHS
// =====================================================
const safeUserPath = path.join(app.getPath("appData"), "GeoSentinelService");
const safeCachePath = path.join(safeUserPath, "Cache");

// Ensure folders exist BEFORE Electron uses them
if (!fs.existsSync(safeUserPath)) {
    fs.mkdirSync(safeUserPath, { recursive: true });
}
if (!fs.existsSync(safeCachePath)) {
    fs.mkdirSync(safeCachePath, { recursive: true });
}

// Force Electron to use safe writable locations
app.setPath("userData", safeUserPath);
app.setPath("cache", safeCachePath);

// =====================================================
// CONFIG
// =====================================================
const { API_URL } = require("./package.json");
const API = API_URL || "https://backend-1-opx1.onrender.com";

let mainWindow = null;
let authToken = null;
let retryDelay = 10000;
let db;
let configPath;
let dbPath;

// =====================================================
// CREATE HIDDEN WINDOW
// =====================================================
function createWindow() {
    mainWindow = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile("index.html");

    session.defaultSession.setPermissionRequestHandler(
        (_, permission, callback) => {
            callback(permission === "geolocation");
        }
    );
}

app.on("window-all-closed", (e) => e.preventDefault());

// =====================================================
// APP READY
// =====================================================
app.whenReady().then(() => {

    configPath = path.join(safeUserPath, "config.json");
    dbPath = path.join(safeUserPath, "local.db");

    // Initialize SQLite
    db = new Database(dbPath);

    db.prepare(`
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            timestamp INTEGER NOT NULL
        )
    `).run();

    handleStationArgument();
    createWindow();

    // Auto start at boot
    app.setLoginItemSettings({
        openAtLogin: true
    });

    setTimeout(startSyncWorker, 5000);
});

// =====================================================
// HANDLE STATION ARGUMENT
// =====================================================
function handleStationArgument() {
    const stationArg = process.argv.find(arg =>
        arg.startsWith("--station=")
    );

    if (stationArg) {
        const stationId = stationArg.split("=")[1];
        if (stationId) {
            fs.writeFileSync(
                configPath,
                JSON.stringify({ stationId }, null, 2)
            );
        }
    }
}

// =====================================================
// GET STATION ID
// =====================================================
function getStationId() {
    if (!fs.existsSync(configPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(configPath)).stationId;
    } catch {
        return null;
    }
}

ipcMain.handle("getStationId", async () => getStationId());

// =====================================================
// LOGIN
// =====================================================
ipcMain.handle("autoLogin", async (_, stationId) => {
    try {
        const res = await axios.post(`${API}/api/auth/auto-login`, { stationId });
        authToken = res.data.token;
        retryDelay = 10000;
        return true;
    } catch {
        return false;
    }
});

// =====================================================
// SAVE LOCATION
// =====================================================
ipcMain.handle("sendLocation", async (_, { lat, lng }) => {

    if (!db) return;

    const result = db.prepare(`
        INSERT INTO locations (latitude, longitude, timestamp)
        VALUES (?, ?, ?)
    `).run(lat, lng, Date.now());

    const insertedId = result.lastInsertRowid;

    if (!authToken) return;

    try {
        await axios.post(
            `${API}/api/location/update`,
            { latitude: lat, longitude: lng },
            { headers: { Authorization: authToken } }
        );

        db.prepare("DELETE FROM locations WHERE id = ?")
            .run(insertedId);

    } catch { }
});

// =====================================================
// HEARTBEAT
// =====================================================
ipcMain.handle("sendHeartbeat", async () => {
    if (!authToken) return;
    try {
        await axios.post(
            `${API}/api/heartbeat`,
            {},
            { headers: { Authorization: authToken } }
        );
    } catch { }
});

// =====================================================
// AUTO RELOGIN
// =====================================================
async function tryReLogin() {
    const stationId = getStationId();
    if (!stationId) return false;

    try {
        const res = await axios.post(`${API}/api/auth/auto-login`, { stationId });
        authToken = res.data.token;
        return true;
    } catch {
        return false;
    }
}

// =====================================================
// SYNC WORKER
// =====================================================
async function startSyncWorker() {
    while (true) {
        await new Promise(r => setTimeout(r, retryDelay));

        if (!authToken) {
            const success = await tryReLogin();
            if (!success) {
                retryDelay = Math.min(retryDelay * 2, 60000);
                continue;
            }
        }

        try {
            const rows = db.prepare(`SELECT * FROM locations LIMIT 20`).all();
            if (rows.length === 0) {
                retryDelay = 10000;
                continue;
            }

            await axios.post(
                `${API}/api/location/batch`,
                { records: rows },
                { headers: { Authorization: authToken } }
            );

            const tx = db.transaction(() => {
                rows.forEach(row => {
                    db.prepare("DELETE FROM locations WHERE id = ?")
                        .run(row.id);
                });
            });

            tx();
            retryDelay = 10000;

        } catch {
            authToken = null;
            retryDelay = Math.min(retryDelay * 2, 60000);
        }
    }
}