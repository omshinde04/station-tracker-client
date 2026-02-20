const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const Database = require("better-sqlite3");

// =====================================
// APP CONFIG
// =====================================
app.setName("GeoSentinelService");
app.dock?.hide(); // macOS hide dock

// Use injected API_URL from electron-builder
const { API_URL } = require("./package.json");
const API = API_URL || "https://backend-1-opx1.onrender.com";

let mainWindow = null;
let authToken = null;
let retryDelay = 10000;

const configPath = path.join(app.getPath("userData"), "config.json");
const dbPath = path.join(app.getPath("userData"), "local.db");

// =====================================
// HANDLE INSTALLER ARGUMENT
// =====================================
function handleInstallerArguments() {
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

// =====================================
// SQLITE INIT
// =====================================
const db = new Database(dbPath);

db.prepare(`
CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    timestamp INTEGER NOT NULL
)
`).run();

// =====================================
// CREATE HIDDEN WINDOW
// =====================================
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

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

// Prevent app from quitting
app.on("window-all-closed", (e) => {
    e.preventDefault();
});

// =====================================
// APP READY
// =====================================
app.whenReady().then(() => {

    handleInstallerArguments();
    createWindow();

    // Auto start after reboot
    app.setLoginItemSettings({
        openAtLogin: true
    });

    setTimeout(startSyncWorker, Math.random() * 20000);
});

// =====================================
// CONFIG
// =====================================
function getStationId() {
    if (!fs.existsSync(configPath)) return null;
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.stationId || null;
}

ipcMain.handle("getStationId", async () => {
    return getStationId();
});

// =====================================
// LOGIN
// =====================================
ipcMain.handle("autoLogin", async (_, stationId) => {
    try {
        const res = await axios.post(`${API}/api/auth/auto-login`, {
            stationId
        });

        authToken = res.data.token;
        retryDelay = 10000;
        return true;

    } catch {
        return false;
    }
});

// =====================================
// LOCATION SAVE (OFFLINE FIRST)
// =====================================
ipcMain.handle("sendLocation", async (_, { lat, lng }) => {

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

    } catch {
        // Silent fallback
    }
});

// =====================================
// HEARTBEAT
// =====================================
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

// =====================================
// AUTO RELOGIN
// =====================================
async function tryReLogin() {

    const stationId = getStationId();
    if (!stationId) return false;

    try {
        const res = await axios.post(`${API}/api/auth/auto-login`, {
            stationId
        });

        authToken = res.data.token;
        return true;

    } catch {
        return false;
    }
}

// =====================================
// SYNC WORKER
// =====================================
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

            const rows = db.prepare(`
                SELECT * FROM locations
                LIMIT 20
            `).all();

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