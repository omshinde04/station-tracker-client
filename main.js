const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const Database = require("better-sqlite3");

// =====================================================
// APP CONFIG (SET NAME FIRST)
// =====================================================
app.setName("GeoSentinelService");
if (process.platform === "darwin") app.dock?.hide();

app.commandLine.appendSwitch("disable-gpu");

const { API_URL } = require("./package.json");
const API = API_URL || "https://backend-1-opx1.onrender.com";

let mainWindow = null;
let authToken = null;
let retryDelay = 10000;

let configPath;
let db;
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

    const userDataPath = app.getPath("userData");

    // Ensure folder exists
    if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
    }

    configPath = path.join(userDataPath, "config.json");
    dbPath = path.join(userDataPath, "local.db");

    // Initialize SQLite AFTER folder exists
    db = new Database(dbPath);

    db.prepare(`
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            timestamp INTEGER NOT NULL
        )
    `).run();

    handleInstallerArguments();
    createWindow();

    // Auto start on reboot
    app.setLoginItemSettings({
        openAtLogin: true
    });

    setTimeout(startSyncWorker, 5000);
});

// =====================================================
// HANDLE STATION ARGUMENT
// =====================================================
function handleInstallerArguments() {
    const stationArg = process.argv.find(arg =>
        arg.startsWith("--station=")
    );

    if (stationArg && configPath) {
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
// CONFIG
// =====================================================
function getStationId() {
    if (!configPath || !fs.existsSync(configPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(configPath, "utf-8")).stationId;
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