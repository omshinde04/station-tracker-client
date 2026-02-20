const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const Database = require("better-sqlite3");

// =====================================================
// SAFE USER DIRECTORY SETUP (CRITICAL FOR WINDOWS)
// =====================================================
const userBasePath = path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "GeoSentinelService"
);

// Ensure directory exists BEFORE anything else
if (!fs.existsSync(userBasePath)) {
    fs.mkdirSync(userBasePath, { recursive: true });
}

// Force Electron paths
app.setPath("userData", userBasePath);
app.setPath("cache", path.join(userBasePath, "Cache"));
app.commandLine.appendSwitch("disable-gpu");

// =====================================================
// APP CONFIG
// =====================================================
app.setName("GeoSentinelService");
if (process.platform === "darwin") app.dock?.hide();

const { API_URL } = require("./package.json");
const API = API_URL || "https://backend-1-opx1.onrender.com";

let mainWindow = null;
let authToken = null;
let retryDelay = 10000;

const configPath = path.join(userBasePath, "config.json");
const dbPath = path.join(userBasePath, "local.db");

// =====================================================
// HANDLE STATION ARGUMENT
// =====================================================
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

// =====================================================
// SQLITE INIT
// =====================================================
const db = new Database(dbPath);

db.prepare(`
CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    timestamp INTEGER NOT NULL
)
`).run();

// =====================================================
// CREATE HIDDEN WINDOW (Required for Geolocation)
// =====================================================
function createWindow() {
    mainWindow = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
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
    handleInstallerArguments();
    createWindow();

    app.setLoginItemSettings({
        openAtLogin: true
    });

    setTimeout(startSyncWorker, 5000);
});

// =====================================================
// CONFIG
// =====================================================
function getStationId() {
    if (!fs.existsSync(configPath)) return null;
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
// SAVE LOCATION (Offline First)
// =====================================================
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